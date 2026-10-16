/**
 * Sharing a drop-in: whether it stands on its own (its files are all its own, and it imports only what every Pi Pocket
 * has), and a draft of its index entry, from its doc comment and its files' hashes. Pi Pocket makes no GitHub calls for
 * it: the owner opens the pull request.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import { POCKET_API } from "../extension-web.ts";
import type { ExtensionInfo } from "../reload.ts";
import {
    type Declares,
    EntryError,
    fileProblem,
    LIMITS,
    NAME,
    parseEntry,
    sha256,
} from "./entry.ts";
import { exists, textOf, type Written } from "./files.ts";

/** The packages a browser module can import by name: the app's import map (`web/index.html`). */
const BROWSER_PACKAGES = new Set(["preact", "preact/hooks", "htm", "marked", "dompurify"]);

/**
 * What a file imports when it runs: `import … from`, `export … from`, `import "…"`, and `import("…")`, but not
 * `import type`, which is erased. Read from the text, so it can only be a first check: the index loads the module.
 */
function specifiers(source: string): Set<string> {
    // Comments first, so a `from "…"` in one is not read as an import.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const found = (pattern: RegExp) => [...code.matchAll(pattern)].map((match) => match[2]!);

    return new Set([
        ...found(/\b(?:import|export)\s+(?!type\s)[^;]*?\bfrom\s*(["'])([^"'\n]+)\1/g),
        ...found(/\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g),
        ...found(/(?:^|[;\s])import\s*(["'])([^"'\n]+)\1/g),
    ]);
}

/** A package's name from a specifier: `@scope/name` or `name`, without the path in it. */
function packageOf(spec: string): string {
    const parts = spec.split("/");

    return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/**
 * What keeps a drop-in from standing on its own, in words: imports of files that are not among its own, of files by
 * where they are on this machine, of code from other sites, or of packages Pi Pocket does not have.
 */
export function importProblems(
    name: string,
    files: { name: string; text: string | undefined }[],
    packages: ReadonlySet<string>,
): string[] {
    const problems: string[] = [];
    const names = new Set(files.map((file) => file.name));

    for (const file of files) {
        if (file.text === undefined || !/\.(ts|js|mjs)$/.test(file.name)) {
            continue;
        }

        const browser = !file.name.endsWith(".ts");

        for (const spec of specifiers(file.text)) {
            if (spec.startsWith("./") || spec.startsWith("../")) {
                const target = posix.normalize(posix.join(posix.dirname(file.name), spec));

                if (!names.has(target)) {
                    problems.push(
                        `${file.name} imports ${spec}, which is not one of its own files. Move it into ${name}/.`,
                    );
                }

                continue;
            }

            if (spec.startsWith("/") || spec.startsWith("file:") || /^[A-Za-z]:[\\/]/.test(spec)) {
                problems.push(
                    `${file.name} imports ${spec} by where it is on this machine. Others do not have it: use a file of its own.`,
                );
                continue;
            }

            if (/^[a-z][a-z0-9+.-]*:/i.test(spec) && !spec.startsWith("node:")) {
                problems.push(
                    `${file.name} loads ${spec} from elsewhere. Keep its code in its own files.`,
                );
                continue;
            }

            const known = browser
                ? BROWSER_PACKAGES.has(spec)
                : spec.startsWith("node:") ||
                  builtinModules.includes(spec) ||
                  packages.has(packageOf(spec));

            if (!known) {
                problems.push(
                    `${file.name} imports the package ${spec}, which Pi Pocket does not have: others cannot load it.`,
                );
            }
        }
    }

    return problems;
}

/** The first paragraph of a module's `/** … *\/` comment, as one line: its description in the index. */
export function docDescription(source: string): string {
    const comment = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source)?.[1] ?? "";
    const paragraph =
        comment
            .replace(/^\s*\* ?/gm, "")
            .trim()
            .split(/\n\s*\n/)[0] ?? "";

    return paragraph.replace(/\s+/g, " ").trim();
}

/** A title from a module's name, within an entry's 60 characters: `acme-clock` is "Acme clock". */
export function titleOf(name: string): string {
    const words = name.replace(/[-_]+/g, " ").trim().slice(0, 60).trimEnd();

    return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A drop-in's own files, as an entry names them: its module, a browser module beside it, and what its own folder holds
 * (hidden files and `node_modules` left out), regular files only, read no further than the limits. What keeps them from
 * an entry goes in `problems`.
 */
async function ownFiles(
    root: string,
    name: string,
    problems: string[],
    notes: string[],
): Promise<Written[]> {
    const found: Written[] = [];
    const over = { files: false, total: false };
    let total = 0;

    const add = async (file: string, path: string) => {
        const stat = await lstat(path);

        if (stat.isSymbolicLink()) {
            problems.push(`${file} is a link: put the file itself there.`);

            return;
        }

        if (!stat.isFile()) {
            problems.push(`${file} is not a file.`);

            return;
        }

        const problem = fileProblem(file, name);

        if (problem !== undefined) {
            problems.push(`${file} ${problem}.`);

            return;
        }

        if (stat.size > LIMITS.file) {
            problems.push(`${file} is larger than ${LIMITS.file} bytes.`);

            return;
        }

        // Past the limits nothing more is read: the problem is said once, below.
        if (found.length >= LIMITS.files || total + stat.size > LIMITS.total) {
            over.files ||= found.length >= LIMITS.files;
            over.total ||= total + stat.size > LIMITS.total;

            return;
        }

        total += stat.size;
        found.push({ name: file, bytes: await readFile(path) });
    };

    const walk = async (folder: string, prefix: string, depth: number) => {
        const entries = await readdir(folder, { withFileTypes: true });

        for (const each of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const file = `${prefix}/${each.name}`;

            if (each.name.startsWith(".") || each.name === "node_modules") {
                notes.push(`Left out ${file}: hidden files and node_modules are not shared.`);
            } else if (each.isDirectory() && depth < 4) {
                await walk(join(folder, each.name), file, depth + 1);
            } else if (each.isDirectory()) {
                problems.push(`${file} is more than four folders deep.`);
            } else {
                await add(file, join(folder, each.name));
            }
        }
    };

    for (const file of [`${name}.ts`, `${name}.js`, `${name}.mjs`]) {
        if (await exists(join(root, file))) {
            await add(file, join(root, file));
        }
    }

    const folder = await lstat(join(root, name)).catch(() => undefined);

    if (folder?.isSymbolicLink()) {
        problems.push(`${name}/ is a link: put the folder itself there.`);
    } else if (folder?.isDirectory()) {
        await walk(join(root, name), name, 1);
    }

    if (over.files) {
        problems.push(`It has more than ${LIMITS.files} files.`);
    }

    if (over.total) {
        problems.push(`Its files are more than ${LIMITS.total} bytes together.`);
    }

    return found;
}

/**
 * Whether one of the owner's drop-ins stands on its own, and a draft of its index entry: its description from its doc
 * comment, its files' sizes and hashes, and, while it is on, what it declares. What only its author knows (where its
 * files are on GitHub) stays to fill in. `version` is this Pi Pocket's.
 */
export async function shareDraft(options: {
    root: string;
    module: ExtensionInfo;
    owner: string;
    repoUrl: string | null;
    packages: ReadonlySet<string>;
    version: string;
}) {
    const { root, module, repoUrl } = options;
    const file = module.file;
    const name = file.replace(/\.ts$/, "");
    const problems: string[] = [];
    const notes: string[] = [];

    if (!NAME.test(name)) {
        problems.push(
            `Its name must be 2 to 64 lowercase letters, digits, - and _, starting with a letter or digit: rename ${file}.`,
        );
    }

    const files = NAME.test(name) ? await ownFiles(root, name, problems, notes) : [];
    const texts = files.map((each) => ({ name: each.name, text: textOf(each.bytes) }));

    problems.push(...importProblems(name, texts, options.packages));

    const source = texts.find((each) => each.name === file)?.text ?? "";
    const description = docDescription(source);

    if (description === "") {
        problems.push(`Start ${file} with a /** … */ comment that says what it does.`);
    }

    // An entry's files are its module's name and folder: a browser module named otherwise would not come along.
    const client = /\bweb\.client\(\s*(["'])([^"'\n]+)\1/.exec(source)?.[2];

    if (client !== undefined && ![`${name}.js`, `${name}.mjs`, name].includes(client)) {
        problems.push(
            `Its browser module is ${client}: in the index it must be ${name}.js, ${name}.mjs, or the folder ${name}/. Rename it.`,
        );
    }

    const loaded = module.enabled && module.error === undefined;
    const declares: Declares = {
        extensions: module.extensions.map((each) => each.name),
        tools: module.extensions.flatMap((each) => each.tools),
        readOnlyTools: module.extensions.flatMap((each) => each.readOnlyTools),
        hooks: [...new Set(module.extensions.flatMap((each) => each.hooks))],
        sections: module.extensions.flatMap((each) => each.sections),
        wraps: module.extensions.flatMap((each) => each.wraps),
        routes: module.web?.routes ?? [],
        client: module.web?.client ?? null,
        access: module.web?.access ?? "owner",
        // Only when it has some: a Pi Pocket before 0.14.0 does not read an entry with the field.
        ...((module.web?.commands ?? []).length === 0
            ? {}
            : { commands: module.web!.commands!.map((command) => command.replace(" /", " ")) }),
    };

    if (!loaded) {
        notes.push(
            "It is off, so what it declares is not known here: turn it on once to fill it in, or write it by hand. The index checks it.",
        );
    }

    const entry = {
        name,
        title: titleOf(name),
        description: description.slice(0, 600).trimEnd(),
        tags: [],
        author: { name: options.owner },
        version: "1.0.0",
        source: { repo: "your-github-name/your-repository", commit: "", path: "" },
        files: files.map((each) => ({
            name: each.name,
            sha256: sha256(each.bytes),
            size: each.bytes.byteLength,
        })),
        pocketApi: POCKET_API,
        minPocket: options.version.replace(/[-+].*$/, ""),
        declares,
    };

    // The draft as the index will read it, with what only the author can fill in stood in for.
    try {
        parseEntry({
            ...entry,
            author: { name: entry.author.name || "someone" },
            source: { repo: "someone/something", commit: "0".repeat(40), path: "" },
        });
    } catch (error) {
        if (!(error instanceof EntryError)) {
            throw error;
        }

        problems.push(`The index would refuse it: ${error.message}.`);
    }

    const text = `${JSON.stringify(entry, null, 4)}\n`;

    return {
        file,
        name,
        entry,
        text,
        problems,
        notes,
        declaresKnown: loaded,
        repoUrl,
        contributingUrl: repoUrl === null ? null : `${repoUrl}/blob/HEAD/CONTRIBUTING.md`,
        // GitHub's page for a new file in the index repository's main branch: the sheet adds the entry once the owner
        // filled in where its files are (`value`, while it fits a link).
        newEntryPage:
            repoUrl === null
                ? null
                : `${repoUrl}/new/main/entries?filename=${encodeURIComponent(`${name}.json`)}`,
    };
}
