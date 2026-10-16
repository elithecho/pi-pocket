// Isolated extension-host contracts. Product admission/persistence is tested separately at the manager seam.
import { cleanUp, root, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ExtensionHost } from "../src/server/terminal/host.ts";
import {
    MAX_PACKET_BYTES,
    parseFromHost,
    parseToHost,
    type HostLogEntry,
    type HostSnapshot,
} from "../src/server/terminal/protocol.ts";

const hosts = new Set<ExtensionHost>();

after(async () => {
    await Promise.all([...hosts].map((host) => host.close()));
    cleanUp();
});

function snapshot(cwd: string): HostSnapshot {
    return {
        entries: [
            { type: "session", id: crypto.randomUUID(), timestamp: new Date().toISOString() },
        ],
        busy: false,
        pending: false,
        nativeTools: [],
        activeTools: [],
        thinkingLevel: "off",
        systemPrompt: `Pocket fixture in ${cwd}`,
    };
}

async function fixture(source: string) {
    const directory = mkdtempSync(join(root, "terminal-host-"));
    const cwd = join(directory, "work");
    const agentDir = join(directory, "agent");

    mkdirSync(cwd);
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    const path = join(agentDir, "fixture.ts");

    writeFileSync(path, source);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [path] }));

    return { cwd, agentDir, path, view: snapshot(cwd) };
}

async function open(
    source: Awaited<ReturnType<typeof fixture>>,
    options: Partial<Parameters<typeof ExtensionHost.open>[0]> = {},
) {
    const host = await ExtensionHost.open({
        cwd: source.cwd,
        agentDir: source.agentDir,
        trusted: false,
        snapshot: source.view,
        onDialog: async () => null,
        ...options,
    });

    hosts.add(host);

    return host;
}

function notifications(log: HostLogEntry[]): string[] {
    return log.flatMap((item) => (item.effect.kind === "notify" ? [item.effect.message] : []));
}

const counter = `let count = 0;
export default function (pi) {
    pi.registerCommand("count", {
        description: "Count in this plugin module",
        handler: async (args, ctx) => ctx.ui.notify(args + ":" + (++count)),
    });
}`;

test("wire protocol validates tags, fields, effect variants, and packet bounds", () => {
    assert.equal(parseToHost({ type: "ack", through: 0 }).type, "ack");
    assert.equal(
        parseFromHost({
            type: "result",
            id: "op",
            log: [
                {
                    seq: 1,
                    operation: "op",
                    effect: { kind: "complete", result: { nested: [1, true, null] } },
                },
            ],
        }).type,
        "result",
    );
    assert.throws(() =>
        parseFromHost({
            type: "result",
            id: "op",
            log: [{ seq: -1, operation: "op", effect: { kind: "complete", result: null } }],
        }),
    );
    assert.throws(() => parseToHost({ type: "unknown" }));
    assert.throws(
        () => parseFromHost({ type: "error", id: "op", message: "x".repeat(MAX_PACKET_BYTES) }),
        /limit/,
    );
});

test("arbitrary registered commands preserve arguments and same-cwd processes isolate module state", async () => {
    const source = await fixture(counter);
    const a = await open(source);
    const b = await open(source);

    assert.deepEqual(
        a.catalogue.commands.map((command) => command.name),
        ["count"],
    );
    assert.deepEqual(a.catalogue.errors, []);
    const first = await a.invoke(
        "a1",
        { kind: "command", name: "count", args: "raw  /args\nnext" },
        source.view,
    );

    assert.deepEqual(notifications(first), ["raw  /args\nnext:1"]);
    a.acknowledge(first.at(-1)!.seq);
    const second = await a.invoke(
        "a2",
        { kind: "command", name: "count", args: "same session" },
        source.view,
    );
    const other = await b.invoke(
        "b1",
        { kind: "command", name: "count", args: "other session" },
        source.view,
    );

    assert.deepEqual(notifications(second), ["same session:2"]);
    assert.deepEqual(notifications(other), ["other session:1"]);
});

test("appendEntry is synchronous and preserved as an SDK custom entry in the effect prefix", async () => {
    const source = await fixture(`export default function (pi) {
        pi.registerCommand("remember", { handler: async (args, ctx) => {
            pi.appendEntry("example-state", { value: args });
            const last = ctx.sessionManager.getBranch().at(-1);
            ctx.ui.notify(last.customType + ":" + last.data.value);
        }});
    }`);
    const host = await open(source);
    const log = await host.invoke(
        "remember",
        { kind: "command", name: "remember", args: "new value" },
        source.view,
    );

    assert.deepEqual(notifications(log), ["example-state:new value"]);
    const first = log[0]!.effect;

    assert.equal(first.kind, "entry");
    assert.match(JSON.stringify(first), /"customType":"example-state"/);
    assert.match(JSON.stringify(first), /"value":"new value"/);
    assert.equal(log.at(-1)!.effect.kind, "complete");
});

test("a command sees a pending tool's synchronous append and can run while its dialog waits", async () => {
    const source = await fixture(`export default function (pi) {
        pi.registerTool({ name: "waiting", description: "Wait for input", parameters: { type: "object", properties: {} },
            execute: async (_id, _args, _signal, _update, ctx) => {
                pi.appendEntry("pending-state", { value: "from tool" });
                await ctx.ui.input("Wait here");
                return { content: [{ type: "text", text: "tool finished" }], details: {} };
            },
        });
        pi.registerCommand("peek", { handler: async (_args, ctx) => {
            const state = ctx.sessionManager.getBranch().findLast(e => e.customType === "pending-state");
            const message = ctx.sessionManager.getBranch().find(e => e.type === "message");
            ctx.ui.notify(state.data.value + ":" + message.message.content);
        }});
    }`);

    let release: (value: string | null) => void = () => {};

    let asked = false;
    const host = await open(source, {
        onDialog: async () => {
            asked = true;

            return new Promise<string | null>((resolve) => {
                release = resolve;
            });
        },
    });
    const tool = host.invoke(
        "pending-tool",
        { kind: "tool", name: "waiting", callId: "call", args: {} },
        source.view,
    );

    await until(() => asked, "the extension tool's input dialog");
    const arrived = {
        type: "message",
        id: "new-history",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "arrived while waiting", timestamp: Date.now() },
    };

    source.view.entries.push(arrived);
    const peek = await host.invoke(
        "concurrent-command",
        { kind: "command", name: "peek", args: "" },
        source.view,
    );

    assert.deepEqual(notifications(peek), ["from tool:arrived while waiting"]);
    assert.equal(
        peek[0]!.operation,
        "pending-tool",
        "command prefix includes the earlier tool append it observed",
    );
    host.acknowledge(peek.at(-1)!.seq);
    release("go");
    const finished = await tool;

    assert.equal(finished.at(-1)!.operation, "pending-tool");
    assert.match(JSON.stringify(finished.at(-1)!.effect), /tool finished/);
});

test("SDK-caught lifecycle errors invalidate the host instead of returning a successful buffered append", async () => {
    const source = await fixture(`export default function (pi) {
        pi.on("agent_start", async () => {
            pi.appendEntry("must-not-commit", { value: 1 });
            throw new Error("fixture lifecycle failure");
        });
    }`);
    const host = await open(source);

    await assert.rejects(
        host.invoke("bad-event", { kind: "event", event: { type: "agent_start" } }, source.view),
        /fixture lifecycle failure/,
    );
    await host.close();
    assert.equal(host.closed, true);
    await assert.rejects(
        host.invoke("stale", { kind: "command", name: "anything", args: "" }, source.view),
        /no longer connected/,
    );
});

test("global loose extensions are excluded before import without disabling configured extensions", async () => {
    const source = await fixture(counter);
    const marker = join(source.cwd, "loose-extension-imported");

    writeFileSync(
        join(source.agentDir, "extensions", "terminal-only.ts"),
        `import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(marker)}, "imported");
        export default function (pi) { pi.on("input", () => ({ action: "continue" })); }`,
    );
    const host = await open(source);

    assert.equal(existsSync(marker), false);
    assert.deepEqual(
        host.catalogue.commands.map((command) => command.name),
        ["count"],
    );
});

test("source filters and project trust exclude import and factory code before execution", async () => {
    const source = await fixture(counter);
    const directory = join(source.cwd, ".pi", "extensions");
    const marker = join(source.cwd, "imported");
    const factoryMarker = join(source.cwd, "factory-ran");

    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "project.ts"),
        `import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(marker)}, "imported");
        export default function (pi) {
            writeFileSync(${JSON.stringify(factoryMarker)}, "factory");
            pi.registerCommand("project-command", { handler: async () => {} });
        }`,
    );
    writeFileSync(
        join(source.agentDir, "settings.json"),
        JSON.stringify({ extensions: ["-" + source.path] }),
    );
    const denied = await open(source);

    assert.deepEqual(denied.catalogue.commands, []);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(factoryMarker), false);
    const trusted = await open(source, { trusted: true });

    assert.deepEqual(
        trusted.catalogue.commands.map((command) => command.name),
        ["project-command"],
    );
    assert.equal(existsSync(marker), true);
    assert.equal(existsSync(factoryMarker), true);
});

test("runtime-registered commands and direct tools publish only after their effect prefix is acknowledged", async () => {
    const source = await fixture(`export default function (pi) {
        pi.registerCommand("install", { handler: async () => {
            pi.registerCommand("late", { handler: async (_args, ctx) => ctx.ui.notify("late command") });
            pi.registerTool({ name: "late_tool", description: "Registered at runtime", parameters: { type: "object", properties: {} },
                execute: async () => ({ content: [{ type: "text", text: "late tool" }], details: {} }),
            });
        }});
    }`);
    const host = await open(source);
    const installed = await host.invoke(
        "install",
        { kind: "command", name: "install", args: "" },
        source.view,
    );

    assert.deepEqual(
        host.catalogue.commands.map((command) => command.name),
        ["install"],
    );
    assert.equal(
        installed.some((item) => item.effect.kind === "catalogue"),
        true,
    );
    host.acknowledge(installed.at(-1)!.seq);
    assert.deepEqual(
        host.catalogue.commands.map((command) => command.name),
        ["install", "late"],
    );
    assert.deepEqual(
        host.catalogue.tools.map((tool) => tool.name),
        ["late_tool"],
    );
    const command = await host.invoke(
        "late-command",
        { kind: "command", name: "late", args: "" },
        source.view,
    );

    assert.deepEqual(notifications(command), ["late command"]);
    host.acknowledge(command.at(-1)!.seq);
    const tool = await host.invoke(
        "late-tool",
        { kind: "tool", name: "late_tool", callId: "call", args: {} },
        source.view,
    );

    assert.match(JSON.stringify(tool.at(-1)!.effect), /late tool/);
});

test("caught detached tool-selection and registration errors cannot mutate the live runtime", async () => {
    const marker = join(root, "detached-attempted");
    const source = await fixture(`import { writeFileSync } from "node:fs";
        export default function (pi) {
            pi.registerTool({ name: "still_active", description: "Must remain active", parameters: { type: "object", properties: {} },
                execute: async () => ({ content: [{ type: "text", text: "still active" }], details: {} }),
            });
            pi.registerCommand("schedule", { handler: async () => {
                setTimeout(() => {
                    try { pi.setActiveTools([]); } catch {}
                    try { pi.registerTool({ name: "intruder_tool", description: "Detached tool", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) }); } catch {}
                    try { pi.registerCommand("intruder", { handler: async () => {} }); } catch {}
                    writeFileSync(${JSON.stringify(marker)}, "attempted");
                }, 20);
            }});
        }`);
    const host = await open(source);
    const scheduled = await host.invoke(
        "schedule",
        { kind: "command", name: "schedule", args: "" },
        source.view,
    );

    host.acknowledge(scheduled.at(-1)!.seq);
    await until(() => existsSync(marker), "the caught detached callbacks");
    const result = await host.invoke(
        "still-active",
        { kind: "tool", name: "still_active", callId: "call", args: {} },
        source.view,
    );

    assert.match(JSON.stringify(result.at(-1)!.effect), /still active/);
    host.acknowledge(result.at(-1)!.seq);
    assert.deepEqual(
        host.catalogue.tools.map((tool) => tool.name),
        ["still_active"],
    );
    assert.deepEqual(
        host.catalogue.commands.map((command) => command.name),
        ["schedule"],
    );
});

test("local package manifests and resource filters are resolved without executing disabled package code", async () => {
    const source = await fixture(counter);
    const packageDir = join(source.agentDir, "local-package");
    const marker = join(source.cwd, "disabled-package-imported");

    mkdirSync(packageDir);
    writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({
            name: "fixture-plugin",
            pi: { extensions: ["allowed.ts", "disabled.ts"] },
        }),
    );
    writeFileSync(
        join(packageDir, "allowed.ts"),
        `export default function (pi) { pi.registerCommand("from-package", { handler: async () => {} }); }`,
    );
    writeFileSync(
        join(packageDir, "disabled.ts"),
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "bad"); export default function () {}`,
    );
    writeFileSync(
        join(source.agentDir, "settings.json"),
        JSON.stringify({
            extensions: ["-" + source.path],
            packages: [{ source: packageDir, extensions: ["allowed.ts"] }],
        }),
    );
    const host = await open(source);

    assert.deepEqual(
        host.catalogue.commands.map((command) => command.name),
        ["from-package"],
    );
    assert.equal(existsSync(marker), false);
});

test("missing configured npm plugins fail without installing packages", async () => {
    const source = await fixture(counter);

    writeFileSync(
        join(source.agentDir, "settings.json"),
        JSON.stringify({ packages: ["npm:pi-pocket-missing-extension-fixture-0000"] }),
    );
    await assert.rejects(open(source), /Missing source/);
    assert.equal(
        existsSync(
            join(
                source.agentDir,
                "npm",
                "node_modules",
                "pi-pocket-missing-extension-fixture-0000",
            ),
        ),
        false,
    );
});

test("disposal terminates retained plugin timers and cancellation invalidates pending requests", async () => {
    const source = await fixture(`export default function (pi) {
        pi.registerCommand("hang", { handler: async () => {
            setInterval(() => {}, 1000);
            await new Promise(() => {});
        }});
    }`);
    const host = await open(source);
    const controller = new AbortController();
    const pending = host.invoke(
        "hanging",
        { kind: "command", name: "hang", args: "" },
        source.view,
        controller.signal,
    );
    const rejected = assert.rejects(pending, /cancelled/);

    controller.abort();
    await rejected;
    await host.close();
    assert.equal(host.closed, true);
    assert.throws(() => process.kill(host.pid!, 0), { code: "ESRCH" });
});

test("unmapped lifecycle registrations fail visibly with event and source provenance", async () => {
    for (const event of [
        "context",
        "message_start",
        "agent_settled",
        "session_shutdown",
        "tool_execution_start",
    ]) {
        const source = await fixture(
            `export default pi => { pi.on(${JSON.stringify(event)}, () => {}); pi.registerCommand("still-listed", { handler: async () => {} }); };`,
        );

        await assert.rejects(open(source), (error) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, new RegExp(`Unsupported.*${event}`));
            assert.equal(error.message.includes(source.path), true);

            return true;
        });
    }
});

test("an unmapped lifecycle registration added by a live command cannot silently install", async () => {
    const source = await fixture(
        `export default pi => pi.registerCommand("register", { handler: async () => pi.on("context", () => ({ messages: [] })) });`,
    );
    const host = await open(source);

    await assert.rejects(
        host.invoke(
            "late-registration",
            { kind: "command", name: "register", args: "" },
            source.view,
        ),
        /Unsupported.*context/,
    );
    await until(() => host.closed, "invalidated host after unsupported registration");
});

test("terminal shortcuts are diagnosed at load and runtime rather than silently registered", async () => {
    const startup = await fixture(
        `export default pi => pi.registerShortcut("ctrl+alt+z", { handler: async () => {} });`,
    );

    await assert.rejects(open(startup), /Unsupported.*terminal shortcuts/);
    const dynamic = await fixture(
        `export default pi => pi.registerCommand("shortcut", { handler: async () => pi.registerShortcut("ctrl+alt+z", { handler: async () => {} }) });`,
    );
    const host = await open(dynamic);

    await assert.rejects(
        host.invoke("shortcut", { kind: "command", name: "shortcut", args: "" }, dynamic.view),
        /Unsupported.*terminal shortcuts/,
    );
});

test("flag defaults remain readable and renderer registrations use the documented generic fallback", async () => {
    const source = await fixture(`export default pi => {
        pi.registerFlag("fixture-mode", { type: "string", default: "default-value" });
        pi.registerMessageRenderer("portable", () => { throw new Error("terminal renderer must not run"); });
        pi.registerEntryRenderer("portable-state", () => { throw new Error("terminal entry renderer must not run"); });
        pi.registerCommand("check", { handler: async (_, ctx) => {
            ctx.ui.notify(pi.getFlag("fixture-mode"));
            pi.sendMessage({ customType: "portable", content: "Fallback text", display: true });
            pi.appendEntry("portable-state", { value: "saved" });
        }});
    }`);
    const host = await open(source);
    const result = await host.invoke(
        "check",
        { kind: "command", name: "check", args: "" },
        source.view,
    );

    assert.deepEqual(notifications(result), ["default-value"]);
    assert.equal(
        result.some(
            (item) => item.effect.kind === "message" && item.effect.content === "Fallback text",
        ),
        true,
    );
});

test("unsupported model, session and terminal actions fail explicitly without committing buffered effects", async () => {
    for (const [action, capability] of [
        ["await pi.setModel({})", "setModel"],
        ['pi.setThinkingLevel("high")', "setThinkingLevel"],
        ["await ctx.newSession()", "newSession"],
        ["ctx.compact()", "compact"],
        [
            'await ctx.ui.custom(() => { throw new Error("renderer must not execute"); })',
            "custom terminal UI",
        ],
        ["await ctx.modelRegistry.complete()", "modelRegistry.complete"],
        ["await ctx.modelRegistry.getApiKeyAndHeaders()", "modelRegistry.getApiKeyAndHeaders"],
    ]) {
        const source =
            await fixture(`export default pi => pi.registerCommand("blocked", { handler: async (_, ctx) => {
            pi.appendEntry("before-unsupported", { provisional: true });
            ${action};
        }});`);
        const host = await open(source);

        await assert.rejects(
            host.invoke("blocked", { kind: "command", name: "blocked", args: "" }, source.view),
            (error) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /Unsupported in Pi Pocket/);
                assert.equal(error.message.includes(capability!), true);

                return true;
            },
        );
        await until(() => host.closed, "unsupported action invalidates its uncommitted operation");
    }
});

test("a plugin tool cannot use nested execution as a native policy bypass", async () => {
    const source = await fixture(`export default pi => pi.registerTool({
        name: "nested_fixture", description: "Must not bypass native hooks", parameters: { type: "object", properties: {} },
        execute: async (_id, _args, _signal, _update, ctx) => {
            const outcome = await ctx.executeTool("bash", { command: "touch nested-policy-bypass" });
            return { ...outcome.result, isError: outcome.isError };
        },
    });`);
    const host = await open(source);

    const log = await host.invoke(
        "nested",
        { kind: "tool", name: "nested_fixture", args: {}, callId: "nested-call" },
        source.view,
    );
    const completed = log.find((item) => item.effect.kind === "complete")?.effect;

    assert.equal(completed?.kind, "complete");
    assert.ok(
        completed?.kind === "complete" &&
            completed.result &&
            typeof completed.result === "object" &&
            !Array.isArray(completed.result),
    );
    assert.equal(completed.result.isError, true);
    assert.match(
        JSON.stringify(completed.result),
        /Nested tool calls are not available in this context/,
    );
    assert.equal(existsSync(join(source.cwd, "nested-policy-bypass")), false);
});
