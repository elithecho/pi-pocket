/**
 * Feasibility probe, not a production bridge or an npm-test regression suite.
 * Run: node test/extension-runtime-probe.ts
 * A nonzero exit reports a failed architecture gate; all data and plugins are temporary.
 */
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    work,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
    CURRENT_SESSION_VERSION,
    DefaultResourceLoader,
    ExtensionRunner,
    ModelRegistry,
    SessionManager,
    SettingsManager,
    type FileEntry,
    type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";

const exec = promisify(execFile);
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const cases: { name: string; status: "pass" | "fail"; detail: string }[] = [];
let app: App | undefined;

async function check(name: string, run: () => Promise<string>): Promise<void> {
    try {
        cases.push({ name, status: "pass", detail: await run() });
    } catch (error) {
        cases.push({
            name,
            status: "fail",
            detail: error instanceof Error ? error.message : String(error),
        });
    }
}

/** Explicit paths only: the caller must filter owner choice and project trust BEFORE this call. */
async function load(paths: string[], cwd = work): Promise<LoadExtensionsResult> {
    const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: SettingsManager.inMemory({}),
        noExtensions: true,
        additionalExtensionPaths: paths,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
    });

    await loader.reload();
    const result = loader.getExtensions();

    assert.deepEqual(result.errors, [], "a fixture extension must load without errors");

    return result;
}

/** Disposable SDK view of real fork-aware Pocket entries; this never writes a JSONL session. */
async function project(app: App, id: ConversationId): Promise<SessionManager> {
    const conversation = await app.conversation(id);
    const page = await conversation.entries({ order: "ascending" }, 200, undefined, context);

    assert.equal(page.next, undefined, "probe history must fit in one page");
    const entries: FileEntry[] = [
        {
            type: "session",
            version: CURRENT_SESSION_VERSION,
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            cwd: work,
        },
    ];
    let parentId: string | null = null;

    for (const entry of page.items) {
        // The bounded fixture has one model message per transcript entry; full compaction/context-edit
        // projection is a separate production requirement, not something this probe claims to solve.
        const messages = entry.model ?? [];

        assert.ok(messages.length <= 1, "fixture entries must have at most one model message");

        for (const message of messages) {
            if (message.role === "system") {
                continue;
            }

            const id = String(entry.id);

            entries.push({
                type: "message",
                id,
                parentId,
                timestamp: new Date(message.timestamp).toISOString(),
                message,
            });
            parentId = id;
        }
    }

    return SessionManager.inMemory(work, undefined, entries);
}

function runner(
    app: App,
    loaded: LoadExtensionsResult,
    view = SessionManager.inMemory(work),
): { runtime: ExtensionRunner; notices: string[] } {
    const runtime = new ExtensionRunner(
        loaded.extensions,
        loaded.runtime,
        work,
        view,
        new ModelRegistry(app.models),
    );
    const notices: string[] = [];

    runtime.setUIContext(
        { ...runtime.getUIContext(), notify: (message) => notices.push(message) },
        "rpc",
    );

    return { runtime, notices };
}

async function invoke(runtime: ExtensionRunner, name: string, args: string): Promise<void> {
    const command = runtime.getCommand(name);

    assert.ok(command, `the SDK must resolve /${name}`);
    await command.handler(args, runtime.createCommandContext());
}

try {
    app = await openApp(scriptedModel(), join(root, "bridge-probe-data"));
    const fixture = join(root, "ordinary-plugin.ts");

    writeFileSync(
        fixture,
        `let moduleCounter = 0;
export default function (pi) {
    let factoryCounter = 0;
    pi.registerCommand("plugin-example", {
        description: "Arbitrary plugin command, not goal-specific",
        handler: async (args, ctx) => {
            ctx.ui.notify(JSON.stringify({
                args,
                moduleCounter: ++moduleCounter,
                factoryCounter: ++factoryCounter,
                branch: ctx.sessionManager.getBranch(),
            }));
        },
    });
}
`,
    );

    await check("arbitrary command discovery and SDK context invocation", async () => {
        const loaded = await load([fixture]);
        const { runtime, notices } = runner(app!, loaded);

        assert.deepEqual(
            runtime.getRegisteredCommands().map((command) => command.invocationName),
            ["plugin-example"],
        );
        await invoke(runtime, "plugin-example", "arguments with /slashes intact");
        assert.deepEqual(JSON.parse(notices[0]!), {
            args: "arguments with /slashes intact",
            moduleCounter: 1,
            factoryCounter: 1,
            branch: [],
        });
        runtime.invalidate();

        return "Registered /plugin-example invoked through the real SDK command context; no model turn.";
    });

    await check(
        "command context reads the existing Pocket fork before and after reconstruction",
        async () => {
            const origin = await newSession(app!);

            await say(app!, origin, "shared history");
            const page = await (
                await app!.conversation(origin)
            ).entries({ order: "ascending" }, 100, undefined, context);
            const answer = page.items.find((entry) => entry.kind === "pi.assistant");

            assert.ok(answer);
            await say(app!, origin, "origin-only history");
            const { id: fork } = await app!.commands.fork(origin, owner(app!), {
                entryId: Number(answer.id),
            });

            await say(app!, fork, "fork-only history");

            for (let rebuild = 0; rebuild < 2; rebuild++) {
                const view = await project(app!, fork);
                const { runtime, notices } = runner(app!, await load([fixture]), view);

                await invoke(runtime, "plugin-example", "inspect Pocket history");
                const seen = JSON.parse(notices[0]!).branch;
                const text = JSON.stringify(seen);

                assert.match(text, /shared history/);
                assert.match(text, /fork-only history/);
                assert.doesNotMatch(text, /origin-only history/);
                assert.equal(view.getEntry(String(answer.id))?.type, "message");
                assert.equal(
                    runtime.createCommandContext().sessionManager.getSessionFile(),
                    undefined,
                );
                runtime.invalidate();
            }

            return "SDK command sees Pocket's inherited and fork-only messages with stable entry IDs, without a JSONL store.";
        },
    );

    await check("project source filtering precedes import and factory execution", async () => {
        const cwd = join(root, "project-marker-case");
        const directory = join(cwd, ".pi", "extensions");
        const marker = join(root, "project-import-marker");
        const factoryMarker = join(root, "project-factory-marker");
        const path = join(directory, "marker-plugin.ts");

        mkdirSync(directory, { recursive: true });
        writeFileSync(
            path,
            `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "imported");
export default function (pi) {
    writeFileSync(${JSON.stringify(factoryMarker)}, "factory executed");
    pi.registerCommand("marker", { handler: async () => {} });
}
`,
        );

        for (const [trusted, enabled] of [
            [false, true],
            [true, false],
        ]) {
            const loaded = await load(trusted && enabled ? [path] : [], cwd);

            assert.equal(loaded.extensions.length, 0);
            assert.equal(existsSync(marker), false);
            assert.equal(existsSync(factoryMarker), false);
        }

        const loaded = await load([path], cwd);

        assert.deepEqual([...loaded.extensions[0]!.commands.keys()], ["marker"]);
        assert.equal(readFileSync(marker, "utf8"), "imported");
        assert.equal(readFileSync(factoryMarker, "utf8"), "factory executed");

        return "Explicit-path loading excludes project auto-discovery; prefiltered denied sources never execute. Production trust/config discovery is not implemented.";
    });

    await check(
        "same-workspace conversation instances do not share module-level plugin state",
        async () => {
            // Use a fresh source and cwd to avoid borrowing state from preceding probe cases. Both loaders
            // intentionally use the SAME cwd, as two real Pocket conversations commonly would.
            const cwd = join(root, "isolation-case");
            const path = join(root, "isolation-plugin.ts");

            mkdirSync(cwd);
            writeFileSync(path, readFileSync(fixture));
            const first = runner(app!, await load([path], cwd));
            const second = runner(app!, await load([path], cwd));

            try {
                await invoke(first.runtime, "plugin-example", "conversation A");
                await invoke(second.runtime, "plugin-example", "conversation B");
                const a = JSON.parse(first.notices[0]!);
                const b = JSON.parse(second.notices[0]!);

                assert.equal(a.moduleCounter, 1);
                assert.equal(a.factoryCounter, 1);
                assert.equal(
                    b.factoryCounter,
                    1,
                    "separate factories must have independent closures",
                );
                assert.equal(
                    b.moduleCounter,
                    1,
                    `conversation B saw moduleCounter=${b.moduleCounter}; expected 1, independent from A`,
                );
            } finally {
                first.runtime.invalidate();
                second.runtime.invalidate();
            }

            return "Both factory-local and module-level state are isolated across SDK runtimes.";
        },
    );

    await check(
        "alternative: separate extension-host processes isolate the same plugin and cwd",
        async () => {
            const cwd = join(root, "process-isolation-case");
            const path = join(root, "process-isolation-plugin.ts");

            mkdirSync(cwd);
            writeFileSync(path, readFileSync(fixture));
            // These children host only the extension runtime: no agent loop, provider call, Pocket
            // server, or persistent SDK session. This tests module isolation, NOT an IPC state bridge.
            const source = `
import {
    DefaultResourceLoader, SettingsManager, ExtensionRunner, SessionManager,
    ModelRegistry, ModelRuntime,
} from "@earendil-works/pi-coding-agent";
const [path, cwd, agentDir] = process.argv.slice(1);
const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, additionalExtensionPaths: [path],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
});
await loader.reload();
const loaded = loader.getExtensions();
if (loaded.errors.length) { throw new Error(JSON.stringify(loaded.errors)); }
const models = await ModelRuntime.create({
    authPath: agentDir + "/auth.json", modelsPath: null,
    modelsStorePath: agentDir + "/models-store.json",
    allowModelNetwork: false, refreshOnCreate: false,
});
const runtime = new ExtensionRunner(
    loaded.extensions, loaded.runtime, cwd, SessionManager.inMemory(cwd), new ModelRegistry(models),
);
const notices = [];
runtime.setUIContext({ ...runtime.getUIContext(), notify: message => notices.push(message) }, "rpc");
await runtime.getCommand("plugin-example").handler("isolated command", runtime.createCommandContext());
console.log(JSON.stringify(notices));
runtime.invalidate();
`;

            for (let index = 0; index < 2; index++) {
                const childAgentDir = join(root, `isolated-agent-${index}`);

                mkdirSync(childAgentDir);
                const { stdout } = await exec(
                    process.execPath,
                    ["--input-type=module", "--eval", source, path, cwd, childAgentDir],
                    {
                        env: { ...process.env, PI_CODING_AGENT_DIR: childAgentDir },
                        timeout: 30_000,
                    },
                );
                const notices = JSON.parse(stdout);

                assert.equal(notices.length, 1);
                assert.deepEqual(JSON.parse(notices[0]), {
                    args: "isolated command",
                    moduleCounter: 1,
                    factoryCounter: 1,
                    branch: [],
                });
            }

            return "Two fresh processes each see moduleCounter=1. State transport, crash recovery, cost, and long-lived IPC remain unproven.";
        },
    );
} finally {
    await app?.close();
    cleanUp();
}

console.log(JSON.stringify({ cases }, null, 2));

if (cases.some((entry) => entry.status === "fail")) {
    console.error(
        "BLOCKED: feasibility gate failed. No state/message adapter or production integration should be built on this loading strategy.",
    );
    process.exitCode = 1;
}
