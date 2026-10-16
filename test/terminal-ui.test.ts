// Generic terminal-plugin commands and portable UI through real HTTP and Chromium, never live data.
import {
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { TerminalStateDoc } from "../src/server/docs.ts";
import { context } from "./helpers.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser" : false };
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let id: Awaited<ReturnType<typeof newSession>>;
const provider = scriptedModel();

const evaluate = async <T>(script: string, on = page): Promise<T> =>
    JSON.parse(await on.evaluate(script)) as T;
const see = (script: string, what: string, on = page) =>
    until(async () => await evaluate<boolean>(`return JSON.stringify(${script})`, on), what);

async function type(text: string) {
    await page.type({ selector: ".composer textarea" }, text);
}

async function send(text: string) {
    await type(text);
    await page.click({ label: "Send" });
}

async function state() {
    const entries = (await app.harness.snapshot(TerminalStateDoc, id, context))?.entries ?? [];

    return entries.flatMap(({ sdk }) =>
        sdk && typeof sdk === "object" && !Array.isArray(sdk) && sdk.type === "custom"
            ? [{ sdk }]
            : [],
    );
}

before(async () => {
    if (real.skip) {
        return;
    }

    const agentDir = process.env.PI_CODING_AGENT_DIR!;
    const extensions = join(agentDir, "extensions");

    mkdirSync(extensions, { recursive: true });
    const plugin = join(agentDir, "portable.ts");

    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [plugin] }));
    const prompts = join(agentDir, "prompts");

    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, "ext:portable.md"), "Template expansion $1");
    writeFileSync(
        plugin,
        `let count = 0;
export default function(pi) {
    pi.registerCommand("portable", { description: "Portable fixture command", handler: async (args, ctx) => {
        pi.appendEntry("portable", { count: ++count, args });
        ctx.ui.setStatus("portable", "Count " + count);
        ctx.ui.setWidget("above", ["Above widget"]);
        ctx.ui.setWidget("below", ["Below widget"], { placement: "belowEditor" });
    }});
    pi.registerCommand("portable-note", { description: "Terminal collision fixture", handler: async (args) => pi.appendEntry("portable-note", { args }) });
    pi.registerCommand("model", { handler: async (_, ctx) => ctx.ui.setStatus("collision", "Plugin model ran") });
    pi.registerCommand("question", { handler: async (kind, ctx) => {
        let answer;
        if (kind === "confirm") answer = await ctx.ui.confirm("Replace fixture?", "No model call");
        if (kind === "input") answer = await ctx.ui.input("Fixture input", "Type here");
        if (kind === "select") answer = await ctx.ui.select("Fixture select", ["One", "Two"]);
        if (kind === "editor") answer = await ctx.ui.editor("Fixture editor", "Initial text");
        pi.appendEntry("answer", { kind, answer: answer ?? null });
        ctx.ui.setStatus("answer", kind + ": " + JSON.stringify(answer ?? null));
    }});
    pi.registerCommand("expires", { handler: async (_, ctx) => {
        const answer = await ctx.ui.confirm("Expiring question", "Wait briefly", { timeout: 100 });
        pi.appendEntry("expired", { answer });
    }});
    pi.registerCommand("passive", { handler: async args => {
        pi.sendMessage({ customType: "portable-update", content: args, display: true });
        pi.sendMessage({ customType: "portable-hidden", content: "Hidden model-only plugin update", display: false });
    }});
    pi.registerCommand("prefill", { handler: async (_, ctx) => ctx.ui.setEditorText("Prepared input") });
    pi.registerCommand("clearbox", { handler: async (_, ctx) => ctx.ui.setEditorText("") });
}`,
    );
    app = await openApp(provider);
    id = await newSession(app);
    await app.setExtensionEnabled(owner(app), "terminal.ts", true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "terminal-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${id}`);
    await see(`document.querySelector(".composer textarea") !== null`, "composer");
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "plugin suggestions fill the editor; raw args, provenance, collisions and widgets work on desktop and phone",
    real,
    async () => {
        for (const viewport of [VIEWPORTS.desktop, VIEWPORTS.mobile]) {
            await page.setViewport(viewport);
            await type("/porta");
            await see(
                `[...document.querySelectorAll("[role=option]")].some(e => e.textContent.includes("/portable"))`,
                "plugin suggestion",
            );
            assert.match(
                await evaluate<string>(
                    `return JSON.stringify(document.querySelector("[role=option]").textContent)`,
                ),
                /Pi extension/,
            );
            const before = (await state()).length;

            await page.click({ selector: "[role=option]" });
            assert.equal(
                await evaluate<string>(
                    `return JSON.stringify(document.querySelector(".composer textarea").value)`,
                ),
                "/portable ",
            );
            assert.equal(
                (await state()).length,
                before,
                "choosing an argumentless command does not execute it",
            );
            await send("/portable\nraw  \nmore  ");
            await see(
                `document.querySelector(".terminal-status")?.textContent.includes("Count") === true`,
                "status",
            );
            await see(`document.querySelector('.composer textarea').value === ''`, "command done");
            assert.equal(
                (await state()).some(
                    ({ sdk }) =>
                        sdk.type === "custom" &&
                        sdk.customType === "portable" &&
                        (sdk.data as { args: string }).args === "raw  \nmore  ",
                ),
                true,
            );
            assert.equal(
                await evaluate<boolean>(
                    `return JSON.stringify(document.querySelector('.dock [aria-label="above"]')?.textContent.includes('Above widget') && !document.querySelector('.dock [aria-label="below"]') && document.querySelector('[aria-label="below"]')?.textContent.includes('Below widget'))`,
                ),
                true,
            );
            assert.equal(
                await evaluate<boolean>(
                    `return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)`,
                ),
                true,
            );
            await type("/ext:mo");
            await see(
                `[...document.querySelectorAll('[role=option]')].some(e => e.textContent.includes('/ext:model'))`,
                "qualified collision",
            );
            await send("/ext:model");
            await see(
                `[...document.querySelectorAll('.terminal-status')].some(e => e.textContent.includes('Plugin model ran'))`,
                "plugin collision dispatched",
            );
        }

        assert.equal(provider.state.callCount, 0);
    },
);

test(
    "confirm, input, select, editor and empty editor replacement use the real portable adapter",
    real,
    async () => {
        for (const kind of ["confirm", "input", "select", "editor"]) {
            await send(`/question ${kind}`);
            await see(`document.querySelector('.terminal-dialog') !== null`, `${kind} dialog`);

            if (kind === "input") {
                await page.type({ selector: ".terminal-dialog input" }, "A typed answer");
            }

            if (kind === "editor") {
                await page.type({ selector: ".terminal-dialog textarea" }, "Edited answer");
            }

            if (kind === "select") {
                await page.evaluate(
                    `const select = document.querySelector('.terminal-dialog select'); select.value = 'Two'; select.dispatchEvent(new Event('change', { bubbles: true }));`,
                );
            }

            assert.equal(
                await evaluate<boolean>(
                    `return JSON.stringify(document.querySelector('.terminal-dialog button[type=submit]').getBoundingClientRect().height >= 40)`,
                ),
                true,
            );
            await page.click({ selector: ".terminal-dialog button[type=submit]" });
            await see(
                `document.querySelector('.terminal-dialog') === null && document.querySelector('.composer textarea').value === ''`,
                "dialog and command done",
            );
        }

        const answers = (await state()).flatMap(({ sdk }) =>
            sdk.type === "custom" && sdk.customType === "answer" ? [sdk.data] : [],
        );

        assert.deepEqual(answers, [
            { kind: "confirm", answer: true },
            { kind: "input", answer: "A typed answer" },
            { kind: "select", answer: "Two" },
            { kind: "editor", answer: "Edited answer" },
        ]);
        await type("Draft to replace");
        await app.terminal.command(id, owner(app), "clearbox", "", "clear-editor");
        await see(
            `document.querySelector('.composer textarea').value === ''`,
            "empty editor replacement",
        );
        await page.evaluate(
            `const original = window.fetch; window.fetch = async (...args) => { const response = await original(...args); if (String(args[0]).endsWith('/terminal/command')) { window.fetch = original; await new Promise(resolve => setTimeout(resolve, 300)); } return response; };`,
        );
        await send("/prefill");
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(
            await evaluate<string>(
                `return JSON.stringify(document.querySelector('.composer textarea').value)`,
            ),
            "Prepared input",
            "a command reply must not erase its own editor effect",
        );
        await type("");
        assert.deepEqual(
            page.logs().filter((line) => line.level === "error"),
            [],
        );
    },
);

test(
    "HTTP rejects unauthorized, cross-person and cross-conversation commands/dialog answers",
    real,
    async () => {
        const guest = app.config.addUser("Other driver", "guest");
        const viewer = app.config.addUser("Reader", "viewer");
        const other = await newSession(app);
        const post = (
            conversation: number,
            route: string,
            body: unknown,
            token = app.config.ownerToken,
        ) =>
            fetch(`${base}/api/c/${conversation}/terminal/${route}`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                body: JSON.stringify(body),
            });
        const running = post(Number(id), "command", {
            name: "question",
            args: "select",
            requestId: "http-question",
        });

        await until(() => app.terminal.dialogs(id, owner(app)).length === 1, "owned dialog");
        const dialog = app.terminal.dialogs(id, owner(app))[0]!;

        assert.equal(
            (
                await post(
                    Number(id),
                    "command",
                    { name: "portable", args: "", requestId: "viewer" },
                    viewer.token,
                )
            ).status,
            403,
        );
        assert.equal(
            (await post(Number(id), "dialog", { id: dialog.id, value: "One" }, viewer.token))
                .status,
            403,
        );
        assert.equal(
            (await post(Number(id), "dialog", { id: dialog.id, value: "One" }, guest.token)).status,
            403,
        );
        assert.equal(
            (await post(Number(other), "dialog", { id: dialog.id, value: "One" })).status,
            404,
        );
        assert.equal(
            (await post(Number(id), "dialog", { id: dialog.id, value: "Not offered" })).status,
            400,
        );
        assert.equal(
            (await post(Number(id), "dialog", { id: dialog.id, value: null })).status,
            200,
        );
        assert.equal((await running).status, 200);
        assert.equal(
            (
                await post(Number(id), "command", {
                    name: "removed-command",
                    args: "",
                    requestId: "stale",
                })
            ).status,
            404,
        );
        assert.equal(
            (await post(Number(id), "command", { name: "portable", args: "" })).status,
            400,
        );
        assert.equal(provider.state.callCount, 0);
    },
);

test("losing driver rights cancels a pending dialog and refuses a new command", real, async () => {
    const other = app.config.addUser("Next driver", "guest").user;

    await app.collab.turns(id, owner(app), { action: "on" });
    const before = (await state()).filter(({ sdk }) => sdk.customType === "answer").length;
    const running = app.terminal.command(id, owner(app), "question", "confirm", "driver-dialog");

    try {
        await until(
            () => app.terminal.dialogs(id, owner(app)).length === 1,
            "dialog before handover",
        );
        const dialog = app.terminal.dialogs(id, owner(app))[0]!;

        await app.collab.turns(id, owner(app), { action: "handover", to: other.id });
        await assert.rejects(
            app.terminal.command(id, owner(app), "portable", "", "lost-driver-command"),
            { status: 409 },
        );
        await assert.rejects(app.terminal.answer(id, owner(app), dialog.id, true), { status: 409 });
        await assert.rejects(running, { status: 409 });
        assert.equal(app.terminal.dialogs(id, owner(app)).length, 0);
        assert.equal(
            (await state()).filter(({ sdk }) => sdk.customType === "answer").length,
            before,
            "the failed operation commits no new answer effects",
        );
    } finally {
        await app.collab.turns(id, owner(app), { action: "off" });
    }
});

test("timeouts and browser reload cancel pending portable dialogs safely", real, async () => {
    await app.terminal.command(id, owner(app), "expires", "", "expires-once");
    assert.deepEqual(
        (await state()).flatMap(({ sdk }) => (sdk.customType === "expired" ? [sdk.data] : [])),
        [{ answer: false }],
    );
    await send("/question confirm");
    await see(`document.querySelector('.terminal-dialog') !== null`, "dialog before reload");
    await page.reload();
    await see(`document.querySelector('.composer textarea') !== null`, "composer reconnected");
    await until(() => app.terminal.dialogs(id, owner(app)).length === 0, "reload dismissed dialog");
    assert.deepEqual(
        (await state())
            .flatMap(({ sdk }) => (sdk.customType === "answer" ? [sdk.data] : []))
            .at(-1),
        { kind: "confirm", answer: false },
    );
    // A stale draft after reload is not automatically executed.
    await type("");
});

test(
    "superseded slash-catalogue failures do not replace the current loading/error state",
    real,
    async () => {
        assert.deepEqual(
            await evaluate(`
        const { actions, store } = await import('/store.js');
        const { loadTemplates } = await import('/commands.js');
        const original = actions.prompts;
        const requests = [];
        actions.prompts = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
        loadTemplates(true);
        loadTemplates(true);
        requests[0].reject(new Error('Stale folder failure'));
        await new Promise(resolve => setTimeout(resolve, 0));
        const result = { loading: store.state.templates.loading, error: store.state.templates.error };
        requests[1].resolve([]);
        await new Promise(resolve => setTimeout(resolve, 0));
        actions.prompts = original;
        loadTemplates(true);
        return JSON.stringify(result);
    `),
            { loading: true, error: null },
        );
    },
);

test(
    "a context change invalidates a catalogue response before the refresh effect runs",
    real,
    async () => {
        assert.deepEqual(
            await evaluate(`
        const { actions, store } = await import('/store.js');
        const { currentTemplates, loadTemplates } = await import('/commands.js');
        const original = actions.prompts;
        const server = store.state.server;
        let reject;
        actions.prompts = () => new Promise((_resolve, fail) => { reject = fail; });
        loadTemplates(true);
        store.set({ server: { ...server, extensionRevision: server.extensionRevision + 1 } });
        reject(new Error('Old revision error'));
        await Promise.resolve();
        const result = { error: store.state.templates.error, current: currentTemplates() !== null };
        actions.prompts = original;
        store.set({ server });
        loadTemplates(true);
        return JSON.stringify(result);
    `),
            { error: null, current: false },
        );
    },
);

test(
    "sending an unresolved slash name while its catalogue loads cannot become ordinary model input",
    real,
    async () => {
        const before = provider.state.callCount;

        await page.evaluate(
            `const { actions } = await import('/store.js'); const { loadTemplates } = await import('/commands.js'); window.originalPrompts = actions.prompts; actions.prompts = () => new Promise(() => {}); loadTemplates(true);`,
        );
        await send("/unlisted-command");
        await see(
            `(await import('/store.js')).store.state.notices.some(n => n.message.includes('Wait for slash commands'))`,
            "loading dispatch blocked",
        );
        assert.equal(provider.state.callCount, before);
        await page.evaluate(
            `const { actions } = await import('/store.js'); actions.prompts = window.originalPrompts; (await import('/commands.js')).loadTemplates(true);`,
        );
        await type("");
    },
);

test(
    "a lost HTTP reply retries the same command receipt rather than executing the handler twice",
    real,
    async () => {
        const before = (await state()).filter(
            ({ sdk }) => sdk.type === "custom" && sdk.customType === "portable",
        ).length;

        await page.evaluate(`const original = window.fetch; let lose = true;
        window.fetch = async (...args) => {
            const response = await original(...args);
            if (lose && String(args[0]).endsWith('/terminal/command')) {
                lose = false;
                throw new Error('Simulated lost command reply');
            }
            return response;
        };`);
        await send("/portable retry-once");
        await see(
            `(await import('/store.js')).store.state.notices.some(n => n.message.includes('Simulated lost command reply'))`,
            "lost reply shown",
        );
        await send("/ext:model");
        await see(
            `document.querySelector('.composer textarea').value === ''`,
            "another command succeeded",
        );
        await type("/portable retry-once");
        await page.reload();
        await see(
            `document.querySelector('.composer textarea')?.value === '/portable retry-once'`,
            "uncertain draft restored",
        );
        await see(
            `(await import('/commands.js')).parseCommand('/portable retry-once') !== null`,
            "catalogue restored",
        );
        await page.click({ label: "Send" });
        await see(`document.querySelector('.composer textarea').value === ''`, "retry succeeded");
        assert.equal(
            (await state()).filter(
                ({ sdk }) => sdk.type === "custom" && sdk.customType === "portable",
            ).length,
            before + 1,
        );
    },
);

test(
    "a template in the plugin namespace keeps a distinct usable suggestion and model expansion",
    real,
    async () => {
        const before = provider.state.callCount;

        await type("/template:ext:");
        await see(
            `[...document.querySelectorAll('[role=option]')].some(e => e.textContent.includes('/template:ext:portable'))`,
            "escaped template suggestion",
        );
        assert.equal(
            await evaluate<string>(
                `return JSON.stringify((await import('/commands.js')).parseTemplate('/template:ext:portable hello')?.name)`,
            ),
            "template:ext:portable",
        );
        assert.equal(
            await evaluate<boolean>(
                `return JSON.stringify((await import('/commands.js')).parseCommand('/ext:portable')?.command.extension)`,
            ),
            true,
        );
        await send("/template:ext:portable hello");
        await until(
            () => !app.isBusy(id) && provider.state.callCount >= before + 1,
            "template model request",
        );
        const messages = (await (await app.conversation(id)).context(context)).messages;

        assert.match(JSON.stringify(messages), /Template expansion hello/);
    },
);

test(
    "the owner must accept the OS-privilege warning before enabling terminal plugins",
    real,
    async () => {
        await app.setExtensionEnabled(owner(app), "terminal.ts", false);
        await page.evaluate(
            `const { openSheet } = await import('/store.js'); window.confirm = message => { window.terminalWarning = message; return false; }; openSheet({ type: 'extensions' });`,
        );
        await see(
            `document.querySelector('[aria-label="Terminal extensions: off"]') !== null`,
            "terminal switch off",
        );
        await new Promise((resolve) => setTimeout(resolve, 450));
        await page.click({ label: "Terminal extensions: off" });
        assert.match(
            await evaluate<string>(`return JSON.stringify(window.terminalWarning)`),
            /OS rights[\s\S]*do not sandbox/,
        );
        assert.equal(app.terminal.enabled, false);
        await page.evaluate(`window.confirm = () => true`);
        await page.click({ label: "Terminal extensions: off" });
        await until(() => app.terminal.enabled, "owner-approved terminal enable");
        await see(
            `document.querySelector('[aria-label="Terminal extensions: on"]') !== null`,
            "terminal switch on",
        );
        assert.deepEqual(
            page.logs().filter((line) => line.level === "error"),
            [],
        );
    },
);

test(
    "native web commands coexist with terminal commands and retain receipts and edited drafts",
    real,
    async () => {
        await page.navigate(`${base}/s/${id}`);
        await see(`document.querySelector('.composer textarea') !== null`, "composer ready");
        writeFileSync(
            join(app.dataDir, "extensions", "native-notes.ts"),
            `/** Native command fixture. */
let count = 0;
export default (_host, web) => {
    web.command("native-note", { description: "Native note", args: "[message]", scope: "conversation",
        handler: async (args) => ({ type: "card", output: "Native " + (++count) + ": " + args }) });
    web.command("portable-note", { description: "Must not replace terminal command", args: "[message]", scope: "conversation",
        handler: async () => { throw new Error("Wrong command won the collision"); } });
};`,
        );
        await app.setExtensionEnabled(owner(app), "native-notes.ts", true);
        await type("/native-");
        await see(
            `(await import('/commands.js')).parseCommand('/native-note once') !== null && (await import('/commands.js')).parseCommand('/portable-note collision')?.command.actualName === 'portable-note'`,
            "both command catalogues and terminal collision precedence",
        );
        const calls = provider.state.callCount;

        await send("/portable-note collision");
        await until(
            async () =>
                (await state()).some(
                    ({ sdk }) => sdk.type === "custom" && sdk.customType === "portable-note",
                ),
            "terminal command wins the collision",
        );
        await see(
            `document.querySelector('.composer textarea').value === ''`,
            "terminal command settled",
        );
        await page.evaluate(`window.nativeOriginalFetch = window.fetch; let lose = true;
            window.fetch = async (...args) => {
                const response = await window.nativeOriginalFetch(...args);
                if (lose && String(args[0]).endsWith('/extension-commands')) {
                    lose = false;
                    throw new Error('Lost native reply');
                }
                return response;
            };`);
        await send("/native-note once");
        await see(
            `(await import('/store.js')).store.state.notices.some(n => n.message.includes('Lost native reply'))`,
            "native reply lost",
        );
        await send("/native-note once");
        await see(`document.querySelector('.composer textarea').value === ''`, "native retry done");
        assert.equal(
            await evaluate<number>(
                `return JSON.stringify([...document.querySelectorAll('.shell-card .output')].filter(e => e.textContent === 'Native 1: once').length)`,
            ),
            1,
        );

        await page.evaluate(`window.fetch = async (...args) => {
            const response = await window.nativeOriginalFetch(...args);
            if (String(args[0]).endsWith('/extension-commands')) {
                await new Promise(resolve => { window.releaseNativeReply = resolve; });
            }
            return response;
        };`);
        await send("/native-note edited");
        await see(`typeof window.releaseNativeReply === 'function'`, "native response held");
        await type("Keep this newer draft");
        await page.evaluate(
            `window.releaseNativeReply(); window.fetch = window.nativeOriginalFetch;`,
        );
        await see(
            `document.querySelector('.composer button[aria-label="Send"]')?.disabled === false`,
            "send settled",
        );
        assert.equal(
            await evaluate<string>(
                `return JSON.stringify(document.querySelector('.composer textarea').value)`,
            ),
            "Keep this newer draft",
        );
        assert.equal(provider.state.callCount, calls);
        await type("");
    },
);

test(
    "passive custom messages render as generic plain text, honor display false and survive browser reload",
    real,
    async () => {
        await page.navigate(`${base}/s/${id}`);
        await see(
            `document.querySelector('.composer textarea') !== null`,
            "composer without prior sheet",
        );
        const calls = provider.state.callCount;
        const content = 'Portable update <img src=x onerror="window.pluginInjected=true"> ```';

        await type(`/passive ${content}`);
        await see(
            `document.querySelector('.command-hint')?.textContent.includes('Pi extension') === true && document.querySelector('.composer button[aria-label="Send"]')?.disabled === false`,
            "command catalogue ready",
        );
        await page.click({ label: "Send" });
        await see(
            `[...document.querySelectorAll('.extension-message pre')].some(e => e.textContent === ${JSON.stringify(content)})`,
            "displayed passive message",
        );
        assert.equal(
            await evaluate<boolean>(
                `return JSON.stringify(window.pluginInjected === true || [...document.querySelectorAll('.extension-message')].some(e => e.querySelector('img') || e.textContent.includes('portable-hidden') || e.textContent.includes('Hidden model-only'))) `,
            ),
            false,
        );
        assert.equal(provider.state.callCount, calls);
        await page.reload();
        await see(
            `[...document.querySelectorAll('.extension-message')].some(e => e.textContent.includes('portable-update') && e.querySelector('pre')?.textContent === ${JSON.stringify(content)})`,
            "passive history after reload",
        );
        assert.equal(provider.state.callCount, calls);
    },
);
