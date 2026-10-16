// Whole-bridge failure policy through real Pocket sessions and a scripted provider, never the owner install.
import {
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { TerminalStateDoc, TerminalWorkDoc } from "../src/server/docs.ts";

const apps = new Set<App>();
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const plugin = join(agentDir, "isolation-fixture.ts");
const settings = join(agentDir, "settings.json");

function fixture(mode: "shortcut" | "healthy" | "crash" | "throw" | "boot-hold") {
    writeFileSync(
        plugin,
        mode === "shortcut"
            ? `import { appendFileSync } from "node:fs";
           export default pi => { appendFileSync("spawn-audit", process.pid + "\\n"); pi.registerShortcut("ctrl+shift+s", { handler: async () => {} }); };`
            : `import { appendFileSync } from "node:fs";
           export default function(pi) {
            appendFileSync("spawn-audit", process.pid + "\\n");
            ${mode === "boot-hold" ? `pi.on("session_start", async (_, ctx) => { await ctx.ui.confirm("Boot held", "Wait for disable"); await new Promise(() => {}); });` : ""}
            pi.registerCommand("health", { handler: async () => pi.appendEntry("health", { okay: true }) });
            pi.registerCommand("hold", { handler: async (_, ctx) => { await ctx.ui.confirm("Pending", "Hold this command"); } });
            pi.registerCommand("enqueue", { handler: async () => pi.sendUserMessage("queued from plugin") });
            pi.registerCommand("select", { handler: async () => pi.setActiveTools(["read", "plugin_check"]) });
            pi.registerTool({ name: "plugin_check", description: "Plugin check", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "plugin healthy" }] }) });
            pi.on("tool_call", async event => {
                if (event.toolName === "bash" && ["hold-hook", "printf held > marker.txt"].includes(event.input.command)) {
                    appendFileSync("hook-started", "x");
                    await new Promise(() => {});
                }
                if (event.toolName === "bash" && event.input.command === "printf guarded > marker.txt") return { block: true, reason: "plugin guard" };
                if (event.toolName === "bash" && event.input.command === "printf mutate > marker.txt") event.input.command = "printf mutated > marker.txt";
                if (event.toolName === "bash" && event.input.command === "printf fault > marker.txt") {
                    ${mode === "crash" ? "process.exit(42);" : mode === "throw" ? "throw new Error('plugin hook failed');" : ""}
                }
            });
        }`,
    );
    writeFileSync(settings, JSON.stringify({ extensions: [plugin] }));
}

function model() {
    return scriptedModel((request) => {
        const last = lastText(request as never);

        if (last.role === "user") {
            if (last.text === "held native") {
                return fauxAssistantMessage(
                    [fauxToolCall("bash", { command: "printf held > marker.txt" })],
                    {
                        stopReason: "toolUse",
                    },
                );
            }

            if (last.text === "read native") {
                return fauxAssistantMessage([fauxToolCall("read", { path: "input.txt" })], {
                    stopReason: "toolUse",
                });
            }

            const command = last.text.includes("fault")
                ? "printf fault > marker.txt"
                : "printf native > marker.txt";

            return fauxAssistantMessage([fauxToolCall("bash", { command })], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([fauxText("finished")]);
    });
}

async function setup(name: string, policy?: "optional" | "required") {
    const dataDir = join(root, name);
    const cwd = join(root, `${name}-work`);

    mkdirSync(cwd);
    const provider = model();
    const app = await openApp(provider, dataDir);

    apps.add(app);

    if (policy) {
        app.config.terminalFailurePolicy = policy;
    }

    const id = await newSession(app, cwd);

    await app.setExtensionEnabled(owner(app), "terminal.ts", true);

    return { app, id, cwd, provider, dataDir };
}

async function tools(app: App, id: ConversationId) {
    return (await (await app.conversation(id)).agent(context)).tools.map((tool) => tool.name);
}

async function result(app: App, id: ConversationId) {
    const messages = (await (await app.conversation(id)).context(context)).messages;

    return JSON.stringify(messages.filter((message) => message.role === "toolResult").at(-1));
}

after(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    cleanUp();
});

test("required default and invalid policy fail closed, optional isolates a startup failure", async () => {
    fixture("shortcut");

    for (const policy of [undefined, "required", "invalid", "optional"] as const) {
        const { app, id, cwd, dataDir } = await setup(`startup-${policy}`);

        if (policy === "invalid") {
            const file = app.config.file;
            const config = JSON.parse(readFileSync(file, "utf8"));

            config.terminalFailurePolicy = "invalid";
            await app.close();
            writeFileSync(file, JSON.stringify(config));
            const reopened = await openApp(model(), dataDir);

            apps.add(reopened);
            assert.equal(reopened.config.terminalFailurePolicy, "required");
            await assert.rejects(say(reopened, id, "run native bash"), /shortcuts/);
            assert.equal(existsSync(join(cwd, "marker.txt")), false);
            assert.match(reopened.terminal.problem(id, owner(reopened))!, /shortcuts/);
            continue;
        }

        if (policy) {
            app.config.terminalFailurePolicy = policy;
        }

        if (policy !== "optional") {
            await assert.rejects(say(app, id, "run native bash"), /shortcuts/);
            assert.equal(existsSync(join(cwd, "marker.txt")), false);
            assert.match(
                app.terminal.problem(id, owner(app))!,
                /unavailable \(required\).*shortcuts/,
            );
            continue;
        }

        await say(app, id, "run native bash");
        assert.equal(existsSync(join(cwd, "marker.txt")), true);
        const text = await result(app, id);

        if (policy === "optional") {
            assert.match(text, /"isError":false/);
            assert.match(
                app.terminal.problem(id, owner(app))!,
                /unavailable \(optional\).*shortcuts/,
            );
            await say(app, id, "again");
            assert.equal(readFileSync(join(cwd, "marker.txt"), "utf8"), "native");
            writeFileSync(join(cwd, "input.txt"), "native read survived");
            await say(app, id, "read native");
            assert.match(await result(app, id), /native read survived/);
            await assert.rejects(
                app.terminal.command(id, owner(app), "health", "", "explicit"),
                /shortcuts/,
            );
            await assert.rejects(app.terminal.catalogue(id, owner(app)), /shortcuts/);
            assert.equal(
                readFileSync(join(cwd, "spawn-audit"), "utf8").trim().split("\n").length,
                1,
            );
        }
    }
});

test("runtime failure quarantines optional hooks and reload restores the complete bridge", async () => {
    fixture("crash");
    const { app, id, cwd } = await setup("runtime-optional", "optional");

    await app.terminal.catalogue(id, owner(app));
    assert.ok((await tools(app, id)).includes("plugin_check"));
    await app.terminal.command(id, owner(app), "health", "", "settled-command");
    const settledTool = { conversationId: id, taskId: 777, callId: "settled-tool" } as never;
    const toolReceipt = await app.terminal.tool(id, "plugin_check", {}, settledTool, context);

    await say(app, id, "fault native call");
    assert.equal(readFileSync(join(cwd, "marker.txt"), "utf8"), "fault");
    assert.equal((await tools(app, id)).includes("plugin_check"), false);
    assert.match(app.terminal.problem(id, owner(app))!, /unavailable \(optional\).*exited/);
    await assert.rejects(
        app.terminal.command(id, owner(app), "health", "", "after-crash"),
        /exited/,
    );
    await app.terminal.command(id, owner(app), "health", "", "settled-command");
    assert.deepEqual(
        await app.terminal.tool(id, "plugin_check", {}, settledTool, context),
        toolReceipt,
    );
    fixture("healthy");
    await app.terminal.resetHosts();
    assert.ok((await tools(app, id)).includes("plugin_check"));
    assert.equal(app.terminal.problem(id, owner(app)), null);
    await app.terminal.command(id, owner(app), "health", "", "after-reload");
    await say(app, id, "run native bash");
    assert.equal(readFileSync(join(cwd, "marker.txt"), "utf8"), "native");
});

test("an unexpected idle child exit quarantines the bridge instead of silently respawning", async () => {
    fixture("healthy");
    const { app, id, cwd } = await setup("idle-crash", "optional");

    await app.terminal.catalogue(id, owner(app));
    const pid = Number(readFileSync(join(cwd, "spawn-audit"), "utf8").trim());

    process.kill(pid, "SIGKILL");
    await until(() => app.terminal.problem(id, owner(app)) !== null, "idle crash warning");
    await say(app, id, "run native bash");
    assert.equal(readFileSync(join(cwd, "marker.txt"), "utf8"), "native");
    assert.equal((await tools(app, id)).includes("plugin_check"), false);
    assert.equal(readFileSync(join(cwd, "spawn-audit"), "utf8").trim().split("\n").length, 1);
});

test("faults persist through eviction and Stop, but context change, re-enable and restart retry", async () => {
    for (const change of ["folder", "trust", "restart", "reenable"] as const) {
        fixture("shortcut");
        let { app, id, dataDir } = await setup(`context-${change}`, "optional");

        await assert.rejects(app.terminal.catalogue(id, owner(app)), /shortcuts/);
        await app.terminal.evict(id, "resume");
        await app.terminal.stop(id, owner(app), async () => {});
        await assert.rejects(app.terminal.catalogue(id, owner(app)), /shortcuts/);
        fixture("healthy");

        if (change === "folder") {
            const next = join(root, "context-next-folder");

            mkdirSync(next, { recursive: true });
            await app.commands.configure(id, owner(app), { cwd: next });
        } else if (change === "trust") {
            app.setProjectTrust(id, owner(app), "trust");
        } else if (change === "restart") {
            await app.close();
            app = await openApp(model(), dataDir);
            apps.add(app);
            assert.equal(app.config.terminalFailurePolicy, "optional");
        } else {
            await app.setExtensionEnabled(owner(app), "terminal.ts", false);
            await app.setExtensionEnabled(owner(app), "terminal.ts", true);
        }

        assert.deepEqual(
            (await app.terminal.catalogue(id, owner(app))).map((item) => item.name),
            ["health", "hold", "enqueue", "select"],
        );
        assert.equal(app.terminal.problem(id, owner(app)), null);
    }
});

test("a thrown runtime plugin hook quarantines optional work without retrying the host", async () => {
    fixture("throw");
    const { app, id, cwd } = await setup("hook-exception", "optional");

    await app.terminal.catalogue(id, owner(app));
    await say(app, id, "fault native call");
    assert.equal(readFileSync(join(cwd, "marker.txt"), "utf8"), "fault");
    assert.match(app.terminal.problem(id, owner(app))!, /plugin hook failed/);
    await say(app, id, "run native bash");
    assert.equal(readFileSync(join(cwd, "marker.txt"), "utf8"), "native");
    assert.equal(readFileSync(join(cwd, "spawn-audit"), "utf8").trim().split("\n").length, 1);
});

test("required runtime hook failure blocks the native tool until explicit reload", async () => {
    fixture("throw");
    const { app, id, cwd } = await setup("runtime-required", "required");

    await app.terminal.catalogue(id, owner(app));
    await say(app, id, "fault native call");
    assert.equal(existsSync(join(cwd, "marker.txt")), false);
    assert.match(await result(app, id), /plugin hook failed/);
    assert.match(app.terminal.problem(id, owner(app))!, /unavailable \(required\)/);
    await assert.rejects(app.terminal.catalogue(id, owner(app)), /plugin hook failed/);
});

test("catalogue load errors invalidate even an otherwise healthy plugin", async () => {
    fixture("healthy");
    const bad = join(agentDir, "broken-isolation-plugin.ts");

    writeFileSync(bad, "export default function (");
    writeFileSync(settings, JSON.stringify({ extensions: [plugin, bad] }));
    const { app, id, cwd } = await setup("partial-catalogue", "optional");

    await say(app, id, "run native bash");
    assert.equal(readFileSync(join(cwd, "marker.txt"), "utf8"), "native");
    assert.match(app.terminal.problem(id, owner(app))!, /broken-isolation-plugin/);
    assert.equal((await tools(app, id)).includes("plugin_check"), false);
    await assert.rejects(app.terminal.catalogue(id, owner(app)), /broken-isolation-plugin/);
});

test("native plan still blocks a write when the optional plugin bridge is quarantined", async () => {
    fixture("shortcut");
    const { app, id, cwd } = await setup("native-plan", "optional");

    await app.commands.setPlan(id, owner(app), true);
    await say(app, id, "run native bash");
    assert.equal(existsSync(join(cwd, "marker.txt")), false);
    assert.match(await result(app, id), /Plan mode is on/);
    assert.match(app.terminal.problem(id, owner(app))!, /unavailable \(optional\)/);
});

test("cancellation, access and store errors are not optional plugin failures", async () => {
    fixture("healthy");
    const { app, id } = await setup("nonhost-errors", "optional");
    const controller = new AbortController();

    controller.abort();
    await assert.rejects(
        app.terminal.event(
            id,
            "aborted-event",
            { type: "agent_start" },
            { ...context, abortSignal: controller.signal },
        ),
        /abort/i,
    );
    const live = new AbortController();
    const running = app.terminal.event(
        id,
        "cancel-running",
        {
            type: "tool_call",
            toolCallId: "cancel",
            toolName: "bash",
            input: { command: "hold-hook" },
        },
        { ...context, abortSignal: live.signal },
    );

    await until(
        () => existsSync(join(root, "nonhost-errors-work", "hook-started")),
        "plugin event entered",
    );
    live.abort();
    await assert.rejects(running, /disposed|cancelled|abort/i);
    await app.terminal.catalogue(id, owner(app));
    const viewer = app.config.addUser("Viewer", "viewer").user;

    await assert.rejects(app.terminal.command(id, viewer, "health", "", "forbidden"), {
        status: 403,
    });
    const lookup = app.terminal.store.lookup.bind(app.terminal.store);

    app.terminal.store.lookup = async () => {
        throw new Error("injected storage fault");
    };

    await assert.rejects(
        app.terminal.event(id, "storage-event", { type: "agent_start" }),
        /injected storage fault/,
    );
    app.terminal.store.lookup = lookup;
    assert.equal(app.terminal.problem(id, owner(app)), null);
    await app.terminal.command(id, owner(app), "health", "", "healthy-after-errors");
});

test("intentional Reload or disable cancels a held plugin guard without executing native bash", async () => {
    fixture("healthy");

    for (const action of ["reload", "disable"] as const) {
        const { app, id, cwd } = await setup(`held-guard-${action}`, "optional");
        const running = say(app, id, "held native");

        await until(() => existsSync(join(cwd, "hook-started")), "plugin tool_call guard entered");

        if (action === "reload") {
            await app.terminal.resetHosts();
        } else {
            await app.setExtensionEnabled(owner(app), "terminal.ts", false);
        }

        await running;
        assert.equal(
            existsSync(join(cwd, "marker.txt")),
            false,
            `${action} must not run the native tool`,
        );
        assert.match(await result(app, id), /disposed|cancelled|interrupted/i);
        assert.equal(app.terminal.problem(id, owner(app)), null);
    }
});

test("failed interruption cleanup never turns a plugin crash into a neutral native hook", async () => {
    fixture("throw");
    const { app, id } = await setup("cleanup-failure", "optional");
    const interrupt = app.terminal.store.interrupt.bind(app.terminal.store);

    await app.terminal.catalogue(id, owner(app));

    app.terminal.store.interrupt = async () => {
        throw new Error("injected interruption fault");
    };

    await assert.rejects(
        app.terminal.event(id, "faulted-cleanup", {
            type: "tool_call",
            toolCallId: "fault",
            toolName: "bash",
            input: { command: "printf fault > marker.txt" },
        }),
        /injected interruption fault/,
    );
    app.terminal.store.interrupt = interrupt;
    await assert.rejects(app.terminal.catalogue(id, owner(app)), /injected interruption fault/);
});

test("healthy plugin guards remain effective under both policies", async () => {
    fixture("healthy");

    for (const policy of ["required", "optional"] as const) {
        const { app, id, cwd } = await setup(`guard-${policy}`, policy);
        const before = await app.terminal.beforeTool(
            { id: "guard", name: "bash", arguments: { command: "printf guarded > marker.txt" } },
            { conversationId: id, taskId: 1 as never } as never,
            context,
        );

        assert.deepEqual(before, { block: "plugin guard" });
        const changed = await app.terminal.beforeTool(
            { id: "mutate", name: "bash", arguments: { command: "printf mutate > marker.txt" } },
            { conversationId: id, taskId: 2 as never } as never,
            context,
        );

        assert.deepEqual(changed, { arguments: { command: "printf mutated > marker.txt" } });
        assert.equal(existsSync(join(cwd, "marker.txt")), false);
    }
});

test("quarantine pauses committed plugin outbox intents until successful reload", async () => {
    fixture("crash");
    const { app, id } = await setup("outbox-pause", "optional");
    const submit = app.commands.submitTerminal.bind(app.commands);

    app.commands.submitTerminal = async () => {
        throw new Error("admission temporarily unavailable");
    };

    await app.terminal.command(id, owner(app), "enqueue", "", "outbox-once");
    await until(
        async () =>
            Object.values(
                (await app.harness.snapshot(TerminalWorkDoc, id, context))?.outbox ?? {},
            ).some((item) => item.status === "blocked"),
        "committed intent blocked",
    );
    await app.terminal.event(id, "crash-outbox", {
        type: "tool_call",
        toolCallId: "crash",
        toolName: "bash",
        input: { command: "printf fault > marker.txt" },
    });
    app.commands.submitTerminal = submit;
    await app.terminal.drain(id);
    assert.equal(
        Object.values(
            (await app.harness.snapshot(TerminalWorkDoc, id, context))?.outbox ?? {},
        ).filter((item) => item.status === "blocked").length,
        1,
    );
    fixture("healthy");
    await app.terminal.resetHosts();
    await until(
        async () =>
            Object.values(
                (await app.harness.snapshot(TerminalWorkDoc, id, context))?.outbox ?? {},
            ).some((item) => item.status === "delivered"),
        "queued intent admitted after reload",
    );
    const messages = (await (await app.conversation(id)).context(context)).messages;

    assert.equal(
        messages.filter(
            (item) =>
                item.role === "user" && JSON.stringify(item.content).includes("queued from plugin"),
        ).length,
        1,
    );
});

test("startup exit after boot receipt waits for quarantine cleanup before optional admission", async () => {
    fixture("healthy");
    const { app, id, cwd } = await setup("startup-drain-exit", "optional");
    const drain = app.terminal.drain.bind(app.terminal);
    const interrupt = app.terminal.store.interrupt.bind(app.terminal.store);
    const drainEntered = Promise.withResolvers<void>();
    const releaseDrain = Promise.withResolvers<void>();
    const cleanupEntered = Promise.withResolvers<void>();
    const releaseCleanup = Promise.withResolvers<void>();
    let holdBoot = true;

    app.terminal.drain = async (conversation) => {
        if (conversation === id && holdBoot) {
            holdBoot = false;
            drainEntered.resolve();
            await releaseDrain.promise;
        }

        return drain(conversation);
    };

    app.terminal.store.interrupt = async (...args) => {
        cleanupEntered.resolve();
        await releaseCleanup.promise;

        return interrupt(...args);
    };

    let settled = false;
    const preparing = app.terminal.prepare(id, owner(app)).finally(() => {
        settled = true;
    });

    await drainEntered.promise;
    const work = await app.harness.snapshot(TerminalWorkDoc, id, context);

    assert.ok(Object.values(work?.operations ?? {}).some((item) => item.status === "done"));
    process.kill(Number(readFileSync(join(cwd, "spawn-audit"), "utf8").trim()), "SIGKILL");
    await cleanupEntered.promise;
    releaseDrain.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
        settled,
        false,
        "admission must wait for interrupted operations and native selection cleanup",
    );
    releaseCleanup.resolve();
    await preparing;
    await say(app, id, "run native bash");
    assert.equal(readFileSync(join(cwd, "marker.txt"), "utf8"), "native");
    assert.equal((await tools(app, id)).includes("plugin_check"), false);
});

test("a concurrent disable cannot be absorbed by a running reload", async () => {
    fixture("healthy");
    const { app, id, cwd } = await setup("reload-disable", "optional");

    await app.terminal.catalogue(id, owner(app));
    const drain = app.terminal.drain.bind(app.terminal);
    const reset = app.terminal.resetHosts.bind(app.terminal);
    const drainEntered = Promise.withResolvers<void>();
    const releaseDrain = Promise.withResolvers<void>();
    const disableEntered = Promise.withResolvers<void>();
    let holdBoot = true;

    app.terminal.drain = async (conversation) => {
        if (conversation === id && holdBoot) {
            holdBoot = false;
            drainEntered.resolve();
            await releaseDrain.promise;
        }

        return drain(conversation);
    };

    app.terminal.resetHosts = async (disabled = false) => {
        if (disabled) {
            disableEntered.resolve();
        }

        return reset(disabled);
    };

    const reloading = app.terminal.resetHosts();

    await drainEntered.promise;
    const pids = readFileSync(join(cwd, "spawn-audit"), "utf8").trim().split("\n").map(Number);
    const replacement = pids.at(-1)!;

    assert.equal(pids.length, 2);
    const disabling = app.setExtensionEnabled(owner(app), "terminal.ts", false);

    await disableEntered.promise;
    releaseDrain.resolve();
    await Promise.all([reloading, disabling]);
    assert.throws(() => process.kill(replacement, 0), { code: "ESRCH" });
    assert.equal((await tools(app, id)).includes("plugin_check"), false);
    assert.equal((await tools(app, id)).includes("bash"), true);
    assert.equal((await app.agentState(id))?.tools, undefined);
    assert.equal((await app.agentState(id))?.extensions, undefined);
});

test("disable cancels a reload stuck inside plugin startup without waiting for its handler", async () => {
    fixture("healthy");
    const { app, id, cwd } = await setup("reload-startup-disable", "optional");

    await app.terminal.catalogue(id, owner(app));
    fixture("boot-hold");
    const reloading = app.terminal.resetHosts().then(
        () => null,
        (error: unknown) => error,
    );

    await until(() => app.terminal.dialogs(id, owner(app)).length === 1, "held reload startup");
    const pid = Number(readFileSync(join(cwd, "spawn-audit"), "utf8").trim().split("\n").at(-1));

    await app.setExtensionEnabled(owner(app), "terminal.ts", false);
    assert.ok((await reloading) instanceof Error);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal((await tools(app, id)).includes("plugin_check"), false);
    assert.equal((await app.agentState(id))?.extensions, undefined);
});

test("a late begin cannot leave an operation started after quarantine cleanup", async () => {
    fixture("healthy");
    const { app, id, cwd } = await setup("late-begin", "optional");

    await app.terminal.catalogue(id, owner(app));
    const original = app.terminal.store.begin.bind(app.terminal.store);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let key = "";

    app.terminal.store.begin = async (...args) => {
        const result = await original(...args);

        key = args[1];
        entered.resolve();
        await release.promise;

        return result;
    };

    const pending = app.terminal.event(id, "late-operation", { type: "agent_start" });

    await entered.promise;
    process.kill(Number(readFileSync(join(cwd, "spawn-audit"), "utf8").trim()), "SIGKILL");
    await until(() => app.terminal.problem(id, owner(app)) !== null, "late host fault");
    await assert.rejects(app.terminal.catalogue(id, owner(app)), /exited/);
    release.resolve();
    assert.equal(await pending, null);
    assert.equal((await app.terminal.store.lookup(id, key))?.status, "interrupted");
});

test("a committed prefix wins the interrupt barrier, while concurrent reloads wait and coalesce", async () => {
    fixture("healthy");
    const { app, id, cwd } = await setup("barrier", "optional");

    await app.terminal.catalogue(id, owner(app));
    const original = app.terminal.store.apply.bind(app.terminal.store);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;

    app.terminal.store.apply = async (conversation, host, log, configure) =>
        original(conversation, host, log, async (tx, effects) => {
            await configure?.(tx, effects);

            if (!held && effects.some((item) => item.effect.kind === "entry")) {
                held = true;
                entered.resolve();
                await release.promise;
            }
        });
    const pending = app.terminal.command(id, owner(app), "hold", "", "held-operation").then(
        () => null,
        (error: unknown) => error,
    );

    await until(() => app.terminal.dialogs(id, owner(app)).length === 1, "pending plugin command");
    const completed = app.terminal.command(id, owner(app), "health", "", "committed-prefix").then(
        () => null,
        (error: unknown) => error,
    );

    await entered.promise;
    const pid = Number(readFileSync(join(cwd, "spawn-audit"), "utf8").trim());

    process.kill(pid, "SIGKILL");
    await until(() => app.terminal.problem(id, owner(app)) !== null, "host fault published");
    fixture("healthy");
    const resets = [app.terminal.resetHosts(), app.terminal.resetHosts()];

    assert.equal(readFileSync(join(cwd, "spawn-audit"), "utf8").trim().split("\n").length, 1);
    release.resolve();
    assert.ok((await pending) instanceof Error);
    await completed;
    await Promise.all(resets);
    const state = await app.harness.snapshot(TerminalStateDoc, id, context);

    assert.equal(
        state?.entries.filter((item) => JSON.stringify(item.sdk).includes("health")).length,
        1,
    );
    assert.equal(readFileSync(join(cwd, "spawn-audit"), "utf8").trim().split("\n").length, 2);
    assert.ok((await tools(app, id)).includes("plugin_check"));
    await app.terminal.command(id, owner(app), "health", "", "committed-prefix");
    assert.equal(
        (await app.harness.snapshot(TerminalStateDoc, id, context))?.entries.length,
        state?.entries.length,
    );
});

test("bridge-owned active tool selection restores its captured native base on quarantine", async () => {
    fixture("crash");
    const { app, id } = await setup("bridge-selection", "optional");

    await app.harness.commit(async (tx) => {
        (await tx.doc(AgentDoc, id)).tools = ["bash", "read"];
    }, context);
    await app.terminal.command(id, owner(app), "select", "", "plugin-select");
    assert.deepEqual((await app.agentState(id))?.tools, ["read", "plugin_check"]);
    await app.terminal.event(id, "bridge-selection-fault", {
        type: "tool_call",
        toolCallId: "fault",
        toolName: "bash",
        input: { command: "printf fault > marker.txt" },
    });
    assert.deepEqual((await app.agentState(id))?.tools, ["bash", "read"]);
    assert.equal((await tools(app, id)).includes("plugin_check"), false);
    await app.setExtensionEnabled(owner(app), "terminal.ts", false);
    assert.deepEqual((await app.agentState(id))?.tools, ["bash", "read"]);
});

test("bridge-owned base allowlist drops plugin names but keeps native tools and removal exclusions", async () => {
    fixture("crash");
    const { app, id } = await setup("bridge-base-allowlist", "optional");

    await app.harness.commit(async (tx) => {
        (await tx.doc(AgentDoc, id)).tools = ["bash", "read", "plugin_check"];
    }, context);
    await app.terminal.command(id, owner(app), "select", "", "plugin-select");
    assert.deepEqual((await app.agentState(id))?.tools, ["read", "plugin_check"]);
    await app.terminal.event(id, "bridge-base-fault", {
        type: "tool_call",
        toolCallId: "fault",
        toolName: "bash",
        input: { command: "printf fault > marker.txt" },
    });
    assert.deepEqual((await app.agentState(id))?.tools, ["bash", "read"]);
    fixture("healthy");
    await app.terminal.resetHosts();
    // A healthy reload still activates plugin tools by the existing worker startup rule;
    // its captured native base must remain the filtered allowlist for later rollback.
    assert.deepEqual((await app.harness.snapshot(TerminalStateDoc, id, context))?.baseTools, {
        mode: "only",
        names: ["bash", "read"],
    });
    await app.setExtensionEnabled(owner(app), "terminal.ts", false);
    assert.deepEqual((await app.agentState(id))?.tools, ["bash", "read"]);
});

test("quarantine keeps the terminal hook and later disable preserves native extension edits", async () => {
    fixture("crash");
    const { app, id } = await setup("extension-selection", "optional");

    await app.harness.commit(async (tx) => {
        (await tx.doc(AgentDoc, id)).extensions = ["pocket-plan"];
    }, context);
    await app.terminal.catalogue(id, owner(app));
    await app.harness.commit(async (tx) => {
        const agent = await tx.doc(AgentDoc, id);

        assert.ok(Array.isArray(agent.extensions));
        agent.extensions = agent.extensions.filter((name) => name !== "pocket-plan");
    }, context);
    await app.terminal.event(id, "extension-selection-fault", {
        type: "tool_call",
        toolCallId: "fault",
        toolName: "bash",
        input: { command: "printf fault > marker.txt" },
    });
    const selected = (await app.agentState(id))?.extensions;

    assert.ok(Array.isArray(selected));
    assert.ok(selected.includes("pocket-terminal"));
    assert.equal(selected.includes("pocket-plan"), false);
    await app.setExtensionEnabled(owner(app), "terminal.ts", false);
    assert.deepEqual((await app.agentState(id))?.extensions, []);
});

test("quarantine preserves native tool-selection modes and retains the selected terminal hook", async () => {
    fixture("crash");

    for (const [label, selection] of [
        ["default", undefined],
        ["allow", ["read", "bash", "plugin_check"]],
        ["remove", { remove: ["plugin_check", "bash"] }],
    ] as const) {
        const { app, id } = await setup(`selection-${label}`, "optional");

        await app.terminal.catalogue(id, owner(app));
        await app.harness.commit(async (tx) => {
            const agent = await tx.doc(AgentDoc, id);

            if (selection === undefined) {
                delete agent.tools;
            } else {
                agent.tools =
                    "remove" in selection ? { remove: [...selection.remove] } : [...selection];
            }
        }, context);
        await app.terminal.beforeTool(
            {
                id: `failure-${label}`,
                name: "bash",
                arguments: { command: "printf fault > marker.txt" },
            },
            { conversationId: id, taskId: 3 as never } as never,
            context,
        );
        const agent = await app.agentState(id);

        assert.deepEqual(agent?.tools, label === "allow" ? ["read", "bash"] : selection);
        assert.equal((await tools(app, id)).includes("plugin_check"), false);
        assert.ok((await tools(app, id)).includes("read"));
        await app.setExtensionEnabled(owner(app), "terminal.ts", false);
        assert.deepEqual(
            (await app.agentState(id))?.tools,
            label === "allow" ? ["read", "bash"] : selection,
        );
    }
});
