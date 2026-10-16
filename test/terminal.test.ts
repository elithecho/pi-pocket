// Production Pocket manager paths with an ordinary Pi extension and scripted provider, no owner installation.
import {
    cleanUp,
    context,
    fakeTab,
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
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { TerminalStateDoc, TerminalWorkDoc } from "../src/server/docs.ts";
import { POCKET_COMMAND_NAMES } from "../src/server/terminal/commands.ts";
import { terminalSnapshot } from "../src/server/terminal/projection.ts";
import { APP_ROOT } from "../src/server/config.ts";

const apps = new Set<App>();
const agentDir = process.env.PI_CODING_AGENT_DIR!;

mkdirSync(agentDir, { recursive: true });
writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ extensions: [join(agentDir, "fixture.ts")] }),
);
writeFileSync(
    join(agentDir, "fixture.ts"),
    `import { existsSync, appendFileSync } from "node:fs";
let count = 0;
export default function (pi) {
    if (existsSync("bridge-start-audit")) appendFileSync("bridge-start-pids", process.pid + "\\n");
    pi.registerCommand("counter", { description: "An arbitrary new command", handler: async (args, ctx) => {
        count++;
        pi.appendEntry("fixture-state", { count, args });
        ctx.ui.setStatus("fixture", "count " + count);
        ctx.ui.notify("counted " + count);
    }});
    pi.registerCommand("crash", { handler: async path => {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(path, "attempt\\n");
        pi.appendEntry("fixture-crash", { unsafe: true });
        process.exit(42);
    }});
    pi.registerCommand("editor-hold", { handler: async (_, ctx) => { ctx.ui.setEditorText("Owner editor effect"); await ctx.ui.confirm("Owner pending", "Wait for another command"); } });
    pi.registerCommand("editor-commit", { handler: async (_, ctx) => ctx.ui.setEditorText("Guest editor effect") });
    pi.registerCommand("host-info", { handler: async () => pi.appendEntry("fixture-host", { pid: process.pid, cwd: process.cwd() }) });
    pi.registerCommand("hold", { handler: async (_, ctx) => { await ctx.ui.confirm("Hold host", "Keep this handler pending"); } });
    pi.registerCommand("expire", { handler: async (_, ctx) => { await ctx.ui.confirm("Expires soon", "Timeout test", { timeout: 100 }); await ctx.ui.confirm("Still running", "The operation outlives its first dialog"); } });
    pi.registerCommand("inspect", { handler: async (_, ctx) => {
        pi.appendEntry("fixture-projection", {
            messages: ctx.sessionManager.buildSessionProjection().messages,
            state: ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "fixture-state").map(e => e.data),
        });
    }});
    pi.registerCommand("weave", { handler: async (args, ctx) => {
        if (args === "write") {
            pi.appendEntry("fixture-weave", { step: "A" });
            pi.sendMessage({ customType: "fixture-weave", content: "B", display: false });
            pi.appendEntry("fixture-weave", { step: "C" });
        }
        pi.appendEntry("fixture-order", { steps: ctx.sessionManager.getBranch().filter(e => e.customType === "fixture-weave").map(e => e.type === "custom" ? e.data.step : e.content) });
    }});
    pi.registerCommand("enqueue", { handler: async () => { pi.appendEntry("fixture-enqueue", { once: true }); pi.sendUserMessage("single queued plugin input"); } });
    pi.registerCommand("launch", { handler: async () => pi.sendUserMessage("run plugin tool") });
    pi.registerCommand("model", { handler: async () => pi.appendEntry("collision", { worked: true }) });
    pi.registerTool({ name: "fixture_tool", description: "A tool from a terminal plugin", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        execute: async (_id, args) => ({ content: [{ type: "text", text: "plugin result " + args.value }], details: { from: "terminal" } }),
    });
    pi.on("session_start", async (event, ctx) => {
        pi.appendEntry("fixture-start", { reason: event.reason });
        if (existsSync("bridge-start-hold")) await ctx.ui.confirm("Startup held", "Wait before startup finishes");
        if (existsSync("bridge-start-ignore")) await new Promise(() => {});
        const previous = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "fixture-state");
        count = previous?.data?.count ?? 0;
        ctx.ui.setStatus("fixture", "restored " + count);
    });
    pi.on("tool_call", event => {
        if (event.toolName === "bash" && event.input.command === "echo bridge-mutate") {
            event.input.command = "printf unsafe > bridge-policy-marker.txt";
        }
    });
    pi.on("turn_start", async event => pi.appendEntry("fixture-event", { type: "turn_start", index: event.turnIndex }));
    pi.on("turn_end", async event => pi.appendEntry("fixture-event", { type: "turn_end", index: event.turnIndex }));
    pi.on("agent_end", async () => pi.appendEntry("fixture-event", { type: "agent_end" }));
    pi.on("message_end", async event => pi.appendEntry("fixture-response", {
        stopReason: event.message.stopReason,
        text: event.message.content.filter(part => part.type === "text").map(part => part.text).join(""),
    }));
}`,
);

after(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    cleanUp();
});

function model() {
    return scriptedModel((request) => {
        const last = lastText(request as never);

        if (last.role === "user" && last.text === "run plugin tool") {
            return fauxAssistantMessage([fauxToolCall("fixture_tool", { value: "done" })], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([fauxText(`echo: ${last.text}`)]);
    });
}

async function setup(name: string) {
    const provider = model();
    const dataDir = join(root, name);
    const app = await openApp(provider, dataDir);

    apps.add(app);
    const id = await newSession(app);

    await app.setExtensionEnabled(owner(app), "terminal.ts", true);

    return { app, id, provider, dataDir };
}

async function values(app: App, id: ConversationId, customType: string) {
    const snapshot = await app.harness.snapshot(TerminalStateDoc, id, context);

    return (snapshot?.entries ?? []).flatMap(({ sdk }) => {
        if (
            sdk &&
            typeof sdk === "object" &&
            !Array.isArray(sdk) &&
            sdk.type === "custom" &&
            sdk.customType === customType
        ) {
            return [sdk.data];
        }

        return [];
    });
}

test("the reserved short-name set matches the actual browser native command table", () => {
    const source = readFileSync(join(APP_ROOT, "web", "commands.js"), "utf8");
    const names = [...source.matchAll(/name: "([^"]+)"/g)]
        .map((match) => match[1]!)
        .filter((name) => name !== "/");

    assert.deepEqual([...POCKET_COMMAND_NAMES].sort(), [...new Set(names)].sort());
});

test("a discovered arbitrary command and tool run through the real manager and native lifecycle", async () => {
    const { app, id, provider } = await setup("manager-tool-flow");
    const commands = await app.terminal.catalogue(id, owner(app));

    assert.deepEqual(commands.map((command) => command.name).sort(), [
        "counter",
        "crash",
        "editor-commit",
        "editor-hold",
        "enqueue",
        "expire",
        "hold",
        "host-info",
        "inspect",
        "launch",
        "model",
        "weave",
    ]);
    await app.terminal.command(id, owner(app), "launch", "", "launch-once");
    await until(
        () => !app.isBusy(id) && provider.state.callCount === 2,
        "the plugin tool and final answer",
        15_000,
    );
    const conversation = await app.conversation(id);
    const current = await conversation.context(context);

    assert.match(JSON.stringify(current.messages), /plugin result done/);
    assert.deepEqual(await values(app, id, "fixture-event"), [
        { type: "turn_start", index: 0 },
        { type: "turn_end", index: 0 },
        { type: "turn_start", index: 1 },
        { type: "turn_end", index: 1 },
        { type: "agent_end" },
    ]);
    assert.equal(app.terminal.problem(id, owner(app)), null);
});

test("module state is isolated and custom state survives idle rehydration and a real Pocket restart", async () => {
    let { app, id, provider, dataDir } = await setup("manager-isolation");
    const other = await newSession(app);

    await app.terminal.command(id, owner(app), "counter", "first", "a1");
    await app.terminal.command(other, owner(app), "counter", "other", "b1");
    assert.deepEqual(await values(app, id, "fixture-state"), [{ count: 1, args: "first" }]);
    assert.deepEqual(await values(app, other, "fixture-state"), [{ count: 1, args: "other" }]);
    await app.terminal.evict(id, "resume");
    await app.terminal.command(id, owner(app), "counter", "second", "a2");
    assert.deepEqual((await values(app, id, "fixture-state")).at(-1), { count: 2, args: "second" });
    await app.close();
    app = await openApp(provider, dataDir);
    apps.add(app);
    await app.terminal.command(id, owner(app), "counter", "after restart", "a3");
    assert.deepEqual((await values(app, id, "fixture-state")).at(-1), {
        count: 3,
        args: "after restart",
    });
    assert.equal(provider.state.callCount, 0);
});

test("the ordinary submit API dispatches slash commands once, preserves raw args, and reserves native names and paths", async () => {
    const { app, id, provider } = await setup("manager-dispatch");
    const text = "/ext:counter raw  \nmore  ";
    const request = { text, requestId: "one-http-request" };
    const first = await app.commands.submit(id, owner(app), request);
    const repeated = await app.commands.submit(id, owner(app), request);

    assert.equal(first.submissionId, repeated.submissionId);
    assert.deepEqual(await values(app, id, "fixture-state"), [{ count: 1, args: "raw  \nmore  " }]);
    assert.equal(provider.state.callCount, 0);
    await app.commands.submit(id, owner(app), {
        text: "/ext:counter\nnewline  ",
        requestId: "newline-separator",
    });
    assert.deepEqual((await values(app, id, "fixture-state")).at(-1), {
        count: 2,
        args: "newline  ",
    });
    assert.equal(provider.state.callCount, 0);
    const path = await app.commands.submit(id, owner(app), {
        text: "/etc/hosts",
        requestId: "path",
    });

    await (await app.harness.submission(path.submissionId, context))!.wait(context);
    assert.equal(provider.state.callCount, 1);
    const selected = (await app.agentState(id))?.model;

    await app.terminal.command(id, owner(app), "model", "", "qualified-native-collision");
    assert.deepEqual((await app.agentState(id))?.model, selected);
    assert.deepEqual(await values(app, id, "collision"), [{ worked: true }]);
    assert.equal(await app.terminal.match(id, owner(app), "/model another"), undefined);
    const projected = await terminalSnapshot(app, id);

    assert.match(JSON.stringify(projected.entries), /raw  /);
});

test("disabling the bridge restores native loadout selection and refuses stale plugin invocations", async () => {
    const { app, id } = await setup("manager-disable");

    await app.terminal.catalogue(id, owner(app));
    assert.equal(
        (await (await app.conversation(id)).agent(context)).tools.some(
            (tool) => tool.name === "fixture_tool",
        ),
        true,
    );
    await app.setExtensionEnabled(owner(app), "terminal.ts", false);
    const agent = await (await app.conversation(id)).agent(context);

    assert.equal(
        agent.tools.some((tool) => tool.name === "fixture_tool"),
        false,
    );
    assert.equal(
        agent.tools.some((tool) => tool.name === "bash"),
        true,
    );
    assert.equal((await app.agentState(id))?.tools, undefined);
    await assert.rejects(app.terminal.command(id, owner(app), "counter", "", "stale"), {
        status: 409,
    });
});

test("the actual worker sees Pocket's fork, compaction and reset context without duplicating native history", async () => {
    const { app, id } = await setup("manager-projection");

    await app.terminal.command(id, owner(app), "counter", "before branch", "branch-state-1");
    await say(app, id, "remember the first branch point");
    const firstAnswer = (
        await (await app.conversation(id)).entries({ order: "ascending" }, 200, undefined, context)
    ).items.find((row) => row.kind === "pi.assistant")!;

    await app.terminal.command(id, owner(app), "counter", "after branch", "branch-state-2");
    await say(app, id, "a later answer with words to summarize in a compaction");
    const fork = await app.commands.fork(id, owner(app), { entryId: Number(firstAnswer.id) });

    const inspect = async (target: ConversationId, key: string) => {
        const native = (await (await app.conversation(target)).context(context)).messages.filter(
            (message) => message.role !== "system",
        );

        await app.terminal.command(target, owner(app), "inspect", "", key);
        const observed = (await values(app, target, "fixture-projection")).at(-1);

        assert.ok(observed && typeof observed === "object" && !Array.isArray(observed));
        assert.deepEqual(observed.messages, JSON.parse(JSON.stringify(native)));

        return observed;
    };

    const inherited = await inspect(fork.id, "inspect-fork");

    assert.deepEqual(inherited.state, [{ count: 1, args: "before branch" }]);
    assert.doesNotMatch(JSON.stringify(inherited.messages), /a later answer/);
    const firstUser = (
        await (await app.conversation(id)).entries({ order: "ascending" }, 200, undefined, context)
    ).items.find((row) => row.kind === "pi.user")!;

    await app.harness.commit(
        (tx) =>
            tx.appendEntry(id, {
                kind: "test.terminal-context-edit",
                edits: [
                    { target: firstUser.id, action: "omit" },
                    {
                        target: firstAnswer.id,
                        action: "replace",
                        messages: [fauxAssistantMessage([fauxText("Edited native contribution")])],
                    },
                ],
            }),
        context,
    );
    const edited = await inspect(id, "inspect-context-edit");

    assert.match(JSON.stringify(edited.messages), /Edited native contribution/);
    assert.doesNotMatch(JSON.stringify(edited.messages), /remember the first branch point/);
    const settings = app.settings.getCompactionSettings;

    app.settings.getCompactionSettings = () => ({
        enabled: true,
        reserveTokens: 16384,
        keepRecentTokens: 1,
    });

    try {
        await app.commands.compact(id, owner(app), "Keep the branch discussion");
        await until(
            async () =>
                (
                    await (
                        await app.conversation(id)
                    ).entries({ order: "ascending" }, 200, undefined, context)
                ).items.some((row) => row.kind === "pi.compaction"),
            "native compaction placed",
        );
        await inspect(id, "inspect-compacted");
        const rows = (
            await (
                await app.conversation(id)
            ).entries({ order: "ascending" }, 200, undefined, context)
        ).items;

        assert.equal(
            rows.some((row) => row.kind === "pi.compaction"),
            true,
        );
    } finally {
        app.settings.getCompactionSettings = settings;
    }

    await app.commands.reset(id, owner(app), "New handoff only");
    const reset = await inspect(id, "inspect-reset");

    assert.match(JSON.stringify(reset.messages), /New handoff only/);
    assert.doesNotMatch(
        JSON.stringify(reset.messages),
        /remember the first branch point|a later answer/,
    );
    assert.deepEqual(reset.state, [
        { count: 1, args: "before branch" },
        { count: 2, args: "after branch" },
    ]);
});

test("message_end observes each provider response across retry without duplicating run/turn boundaries", async () => {
    let calls = 0;
    const provider = scriptedModel(() => {
        calls++;

        return calls === 1
            ? fauxAssistantMessage([], {
                  stopReason: "error",
                  errorMessage: "503 Service Unavailable",
              })
            : fauxAssistantMessage([fauxText("Retry succeeded")]);
    });
    const app = await openApp(provider, join(root, "manager-provider-retry"));

    apps.add(app);
    app.settings.getRetrySettings = () => ({
        enabled: true,
        maxRetries: 1,
        baseDelayMs: 1,
        maxAgentDelayMs: 1,
    });
    const id = await newSession(app);

    await app.setExtensionEnabled(owner(app), "terminal.ts", true);
    await say(app, id, "retry once");
    assert.equal(calls, 2);
    assert.deepEqual(await values(app, id, "fixture-response"), [
        { stopReason: "error", text: "" },
        { stopReason: "stop", text: "Retry succeeded" },
    ]);
    assert.deepEqual(await values(app, id, "fixture-event"), [
        { type: "turn_start", index: 0 },
        { type: "turn_end", index: 0 },
        { type: "agent_end" },
    ]);
});

test("plugin argument mutation is checked by the actual native plan and guard hooks before execution", async () => {
    for (const policy of ["plan", "guard"] as const) {
        const provider = scriptedModel((request) => {
            const last = lastText(request as never);

            return last.role === "user"
                ? fauxAssistantMessage([fauxToolCall("bash", { command: "echo bridge-mutate" })], {
                      stopReason: "toolUse",
                  })
                : fauxAssistantMessage([fauxText("Policy result observed")]);
        });
        const app = await openApp(provider, join(root, `manager-policy-${policy}`));

        apps.add(app);
        const folder = join(root, `policy-work-${policy}`);

        mkdirSync(folder);
        const id = await newSession(app, folder);
        const judged: unknown[] = [];

        await app.setExtensionEnabled(owner(app), "terminal.ts", true);

        if (policy === "plan") {
            await app.commands.setPlan(id, owner(app), true);
        } else {
            // The native guard hook/ordering is real; only its external classifier is deterministic.
            app.guard.judge = async (tool, args) => {
                judged.push({ tool, args });

                return {
                    subject: String(args.command),
                    decision: {
                        action: "block",
                        source: "fixture",
                        reason: "mutated command denied",
                        terminate: false,
                    },
                };
            };

            await app.setExtensionEnabled(owner(app), "guard.ts", true);
        }

        for (const selection of ["default", "explicit", "reenabled"]) {
            if (selection === "explicit") {
                const names = (await (await app.conversation(id)).agent(context)).extensions.map(
                    (extension) => extension.name,
                );

                await app.harness.commit(async (tx) => {
                    (await tx.doc(AgentDoc, id)).extensions = names.reverse();
                }, context);
                await app.terminal.evict(id, "resume");
            } else if (selection === "reenabled") {
                await app.setExtensionEnabled(owner(app), "terminal.ts", false);
                await app.setExtensionEnabled(owner(app), "terminal.ts", true);
            }

            await say(app, id, `exercise ${selection} policy`);
            const messages = (await (await app.conversation(id)).context(context)).messages;
            const result = messages.filter((message) => message.role === "toolResult").at(-1);

            assert.equal(
                existsSync(join(folder, "bridge-policy-marker.txt")),
                false,
                "native policy must check the mutated command before any file write",
            );
            assert.match(
                JSON.stringify(result),
                policy === "plan"
                    ? /Plan mode is on: This command is not a simple read-only one/
                    : /Lancet Guard blocked[\s\S]*mutated command denied/,
            );
        }

        assert.equal(provider.state.callCount, 6);

        if (policy === "guard") {
            assert.deepEqual(
                judged,
                Array.from({ length: 3 }, () => ({
                    tool: "bash",
                    args: { command: "printf unsafe > bridge-policy-marker.txt" },
                })),
            );
        }
    }
});

async function hostInfo(app: App, id: ConversationId, requestId: string) {
    await app.terminal.command(id, owner(app), "host-info", "", requestId);
    const info = (await values(app, id, "fixture-host")).at(-1);

    assert.ok(info && typeof info === "object" && !Array.isArray(info));
    assert.equal(typeof info.pid, "number");

    if (typeof info.pid !== "number") {
        throw new Error("Fixture did not report a pid");
    }

    return { pid: info.pid, cwd: info.cwd };
}

test("manager bounds live hosts, refuses excess busy work, retries after capacity frees and reaps every child on disable", async () => {
    const { app, id } = await setup("manager-capacity");
    const ids = [id];
    const pids: number[] = [];
    const pending: Promise<string>[] = [];

    for (let index = 0; index < 8; index++) {
        const current = index === 0 ? id : await newSession(app);

        if (index > 0) {
            ids.push(current);
        }

        pids.push((await hostInfo(app, current, `pid-${index}`)).pid);
        pending.push(
            app.terminal.command(current, owner(app), "hold", "", `hold-${index}`).then(
                () => "completed",
                (error) => String(error.message),
            ),
        );
        await until(
            () => app.terminal.dialogs(current, owner(app)).length === 1,
            "a busy host dialog",
        );
    }

    const excess = await newSession(app);

    await assert.rejects(app.terminal.catalogue(excess, owner(app)), {
        status: 409,
        message: /hosts are busy.*retry/,
    });
    const dialog = app.terminal.dialogs(id, owner(app))[0]!;

    await app.terminal.answer(id, owner(app), dialog.id, false);
    assert.equal(await pending[0], "completed");
    pids.push((await hostInfo(app, excess, "retry-capacity")).pid);
    assert.equal(new Set(pids).size, 9);
    assert.throws(
        () => process.kill(pids[0]!, 0),
        { code: "ESRCH" },
        "pressure eviction waited for exit",
    );
    await app.setExtensionEnabled(owner(app), "terminal.ts", false);
    const results = await Promise.all(pending.slice(1));

    assert.equal(results.length, 7);
    assert.equal(
        results.every((result) => result !== "completed"),
        true,
        "disabled arbitrary handlers never report success",
    );

    for (const pid of pids) {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }

    for (const current of ids) {
        assert.equal(app.terminal.dialogs(current, owner(app)).length, 0);
    }
});

test("cwd and trust changes replace the host before further dispatch and never import untrusted project code", async () => {
    const { app } = await setup("manager-cwd-trust");
    const first = join(root, "host-project-first");
    const second = join(root, "host-project-second");
    const marker = join(root, "project-import-marker");

    mkdirSync(join(first, ".git"), { recursive: true });
    mkdirSync(join(second, ".git"), { recursive: true });
    mkdirSync(join(first, ".pi", "extensions"), { recursive: true });
    writeFileSync(
        join(first, ".pi", "extensions", "project.ts"),
        `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, "imported\\n"); export default pi => pi.registerCommand("project-only", { handler: async () => pi.appendEntry("project-owned", { ran: true }) });`,
    );
    const id = await newSession(app, first);

    assert.equal(
        (await app.terminal.catalogue(id, owner(app))).some(
            (command) => command.name === "project-only",
        ),
        false,
    );
    assert.equal(existsSync(marker), false);
    const untrusted = await hostInfo(app, id, "untrusted-pid");

    app.setProjectTrust(id, owner(app), "trust");
    assert.equal(
        (await app.terminal.catalogue(id, owner(app))).some(
            (command) => command.name === "project-only",
        ),
        true,
    );
    const trusted = await hostInfo(app, id, "trusted-pid");

    assert.notEqual(trusted.pid, untrusted.pid);
    assert.throws(() => process.kill(untrusted.pid, 0), { code: "ESRCH" });
    await app.terminal.command(id, owner(app), "project-only", "", "trusted-command");
    assert.deepEqual(await values(app, id, "project-owned"), [{ ran: true }]);
    app.setProjectTrust(id, owner(app), "distrust");
    await assert.rejects(
        app.terminal.command(id, owner(app), "project-only", "", "revoked-command"),
        { status: 404 },
    );
    assert.throws(() => process.kill(trusted.pid, 0), { code: "ESRCH" });
    const revoked = await hostInfo(app, id, "revoked-pid");

    await app.commands.configure(id, owner(app), { cwd: second });
    const moved = await hostInfo(app, id, "moved-pid");

    assert.equal(moved.cwd, realpathSync(second));
    assert.notEqual(moved.pid, revoked.pid);
    assert.throws(() => process.kill(revoked.pid, 0), { code: "ESRCH" });
    assert.equal(
        readFileSync(marker, "utf8"),
        "imported\n",
        "only the trusted host evaluated project code",
    );
    await app.setExtensionEnabled(owner(app), "terminal.ts", false);
    assert.throws(() => process.kill(moved.pid, 0), { code: "ESRCH" });
});

test("unexpected host exit interrupts unsafe handlers and required policy recovers only on reload", async () => {
    const { app, id, provider } = await setup("manager-crash");
    const original = await hostInfo(app, id, "before-crash");
    const marker = join(root, "unsafe-handler-attempts");

    await assert.rejects(
        app.terminal.command(id, owner(app), "crash", marker, "unsafe-once"),
        /exited.*42/,
    );
    assert.deepEqual(await values(app, id, "fixture-crash"), []);
    await assert.rejects(
        app.terminal.command(id, owner(app), "crash", marker, "unsafe-once"),
        /exited.*42|interrupted/,
    );
    assert.equal(readFileSync(marker, "utf8"), "attempt\n");
    assert.throws(() => process.kill(original.pid, 0), { code: "ESRCH" });
    await assert.rejects(say(app, id, "native recovery"), /exited.*42/);
    assert.equal(provider.state.callCount, 0);
    await app.terminal.resetHosts();
    await say(app, id, "native recovery");
    assert.equal(provider.state.callCount, 1);
    const fresh = await hostInfo(app, id, "after-crash");

    assert.notEqual(fresh.pid, original.pid);
    assert.match(
        JSON.stringify((await (await app.conversation(id)).context(context)).messages),
        /echo: native recovery/,
    );
});

test("overlapping commands deliver checkpointed editor effects to each original requester exactly once", async () => {
    const { app, id, provider } = await setup("manager-overlap-editor");
    const guest = app.config.addUser("Concurrent editor", "guest").user;
    const mine = fakeTab(id, owner(app));
    const theirs = fakeTab(id, guest);

    await app.attach(mine.client);
    await app.attach(theirs.client);

    try {
        const waiting = app.terminal.command(id, owner(app), "editor-hold", "", "owner-waiting");

        await until(
            () => app.terminal.dialogs(id, owner(app)).length === 1,
            "owner handler pending",
        );
        await app.terminal.command(id, guest, "editor-commit", "", "guest-checkpoint");
        assert.deepEqual(
            mine.events
                .filter((item) => item.event === "terminal-editor")
                .map((item) => item.data.text),
            ["Owner editor effect"],
        );
        assert.deepEqual(
            theirs.events
                .filter((item) => item.event === "terminal-editor")
                .map((item) => item.data.text),
            ["Guest editor effect"],
        );
        const dialog = app.terminal.dialogs(id, owner(app))[0]!;

        await app.terminal.answer(id, owner(app), dialog.id, false);
        await waiting;
        assert.equal(mine.events.filter((item) => item.event === "terminal-editor").length, 1);
        assert.equal(theirs.events.filter((item) => item.event === "terminal-editor").length, 1);
        assert.equal(provider.state.callCount, 0);
    } finally {
        app.detach(mine.client);
        app.detach(theirs.client);
    }
});

test("production manager restart recovers committed queued input in both admission crash windows exactly once", async () => {
    for (const window of ["before-admission", "after-admission"] as const) {
        let { app, id, provider, dataDir } = await setup(`manager-outbox-${window}`);

        await app.terminal.catalogue(id, owner(app));
        const original = app.commands.submitTerminal.bind(app.commands);
        const drain = app.terminal.drain.bind(app.terminal);
        let attempted = false;

        // Freeze later drains in the old process after the injected fault. Otherwise native hooks
        // can repair the admission-before-mark window before the restart being tested.
        app.terminal.drain = async (current) => {
            if (attempted) {
                return;
            }

            attempted = true;
            await drain(current);
        };

        app.commands.submitTerminal = async (...args) => {
            if (window === "after-admission") {
                await original(...args);
            }

            throw new Error(`Simulated process loss ${window}`);
        };

        await app.terminal.command(id, owner(app), "enqueue", "", "enqueue-once");
        assert.deepEqual(await values(app, id, "fixture-enqueue"), [{ once: true }]);
        await until(async () => !app.isBusy(id), "native work before restart");
        assert.equal(provider.state.callCount, window === "before-admission" ? 0 : 1);
        const before = await app.harness.snapshot(TerminalWorkDoc, id, context);

        assert.equal(
            Object.values(before!.outbox).some((intent) => intent.status === "blocked"),
            true,
        );
        await app.close();
        app = await openApp(provider, dataDir);
        apps.add(app);
        await until(
            () => !app.isBusy(id) && provider.state.callCount === 1,
            "one recovered native input",
        );
        await app.terminal.command(id, owner(app), "enqueue", "", "enqueue-once");
        assert.deepEqual(await values(app, id, "fixture-enqueue"), [{ once: true }]);
        assert.equal(provider.state.callCount, 1);
        const messages = (await (await app.conversation(id)).context(context)).messages;

        assert.equal(
            messages.filter(
                (message) =>
                    message.role === "user" &&
                    JSON.stringify(message.content).includes("single queued plugin input"),
            ).length,
            1,
        );
        assert.equal(
            Object.values((await app.harness.snapshot(TerminalWorkDoc, id, context))!.outbox).every(
                (intent) => intent.status === "delivered",
            ),
            true,
        );
    }
});

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
            return false;
        }

        throw error;
    }
}

test("concurrent stale-host discovery creates exactly one replacement and disable reaps all children", async () => {
    const { app, id } = await setup("manager-concurrent-reload");
    const previous = await hostInfo(app, id, "before-concurrent");
    const folder = join(root, "concurrent-replacement");

    mkdirSync(folder);
    writeFileSync(join(folder, "bridge-start-audit"), "");
    await app.commands.configure(id, owner(app), { cwd: folder });
    await Promise.all(Array.from({ length: 12 }, () => app.terminal.catalogue(id, owner(app))));
    const pids = readFileSync(join(folder, "bridge-start-pids"), "utf8")
        .trim()
        .split("\n")
        .map(Number);

    // Always dispose before asserting so the old implementation cannot leak the orphaned children.
    await app.setExtensionEnabled(owner(app), "terminal.ts", false);
    const leaked = pids.filter(alive);

    for (const pid of leaked) {
        process.kill(pid, "SIGKILL");
    }

    assert.deepEqual(leaked, []);
    assert.equal(pids.length, 1);
    assert.equal(alive(previous.pid), false);
});

test("disable cancels startup dialogs without awaiting a running session_start handler", async () => {
    const { app } = await setup("manager-startup-cancel");
    const folder = join(root, "startup-cancel");

    mkdirSync(folder);
    writeFileSync(join(folder, "bridge-start-audit"), "");
    writeFileSync(join(folder, "bridge-start-hold"), "");
    const id = await newSession(app, folder);
    const opening = app.terminal.catalogue(id, owner(app)).then(
        () => null,
        (error) => error,
    );

    await until(() => app.terminal.dialogs(id, owner(app)).length > 0, "startup dialog");
    const pid = Number(readFileSync(join(folder, "bridge-start-pids"), "utf8").trim());
    // Release the old implementation after its deadline assertion rather than hanging the suite.
    const fallback = setTimeout(() => {
        const waiting = app.terminal.dialogs(id, owner(app))[0];

        if (waiting) {
            void app.terminal.answer(id, owner(app), waiting.id, false).catch(() => {});
        }
    }, 1500);
    const began = Date.now();

    await app.setExtensionEnabled(owner(app), "terminal.ts", false);
    clearTimeout(fallback);
    assert.ok((await opening) instanceof Error);
    assert.ok(Date.now() - began < 1000, "disable must cancel rather than await startup");
    assert.equal(alive(pid), false);
    assert.deepEqual(app.terminal.dialogs(id, owner(app)), []);
});

test("exact and removal extension selections retain lifecycle hooks while enabled and restore on disable", async () => {
    for (const selection of [["pocket-plan"], { remove: ["pocket-terminal", "pocket-plan"] }]) {
        const { app, id } = await setup(
            `manager-selection-${Array.isArray(selection) ? "exact" : "remove"}`,
        );

        await app.harness.commit(async (tx) => {
            (await tx.doc(AgentDoc, id)).extensions = selection;
        }, context);
        await app.terminal.command(id, owner(app), "launch", "", "exact-selection");
        await until(() => !app.isBusy(id), "selected native request finished");
        assert.ok(
            (await values(app, id, "fixture-event")).some(
                (event) => (event as { type: string }).type === "agent_end",
            ),
        );
        await app.setExtensionEnabled(owner(app), "terminal.ts", false);
        assert.deepEqual((await app.agentState(id))?.extensions, selection);
    }
});

test("an expired dialog disappears even while its command waits on another dialog", async () => {
    const { app, id } = await setup("manager-dialog-expiry");
    const running = app.terminal.command(id, owner(app), "expire", "", "expire");

    await until(
        () =>
            app.terminal.dialogs(id, owner(app)).some((dialog) => dialog.title === "Expires soon"),
        "first timed dialog",
    );
    const first = app.terminal
        .dialogs(id, owner(app))
        .find((dialog) => dialog.title === "Expires soon")!;

    await until(
        () =>
            app.terminal.dialogs(id, owner(app)).some((dialog) => dialog.title === "Still running"),
        "command outlives its dialog",
    );
    assert.equal(
        app.terminal.dialogs(id, owner(app)).some((dialog) => dialog.id === first.id),
        false,
    );
    await assert.rejects(app.terminal.answer(id, owner(app), first.id, true), { status: 404 });
    const next = app.terminal
        .dialogs(id, owner(app))
        .find((dialog) => dialog.title === "Still running")!;

    await app.terminal.answer(id, owner(app), next.id, false);
    await running;
});

test("idle maintenance reaps a host and later dispatch rehydrates its committed extension state", async (t) => {
    const { app, id } = await setup("manager-idle-rehydration");

    await app.terminal.command(id, owner(app), "counter", "before idle", "idle-before");
    const original = await hostInfo(app, id, "idle-original-pid");

    try {
        t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 6 * 60_000 });
        await until(() => !alive(original.pid), "idle maintenance reaps the child");
    } finally {
        t.mock.timers.reset();
    }

    await app.terminal.command(id, owner(app), "counter", "after idle", "idle-after");
    const replacement = await hostInfo(app, id, "idle-replacement-pid");

    assert.notEqual(replacement.pid, original.pid);
    assert.deepEqual(await values(app, id, "fixture-state"), [
        { count: 1, args: "before idle" },
        { count: 2, args: "after idle" },
    ]);
    assert.equal(
        (await app.harness.snapshot(TerminalStateDoc, id, context))!.statuses.fixture,
        "count 2",
    );
});

test("disabling the bridge preserves native extension-selection edits made after host startup", async () => {
    const { app, id } = await setup("manager-native-selection-edits");

    await app.harness.commit(async (tx) => {
        (await tx.doc(AgentDoc, id)).extensions = ["pocket-plan"];
    }, context);
    await app.terminal.command(id, owner(app), "counter", "before native edit", "selection-before");
    await app.harness.commit(async (tx) => {
        const agent = await tx.doc(AgentDoc, id);

        assert.ok(Array.isArray(agent.extensions));
        agent.extensions = agent.extensions.filter((name) => name !== "pocket-plan");
    }, context);
    await app.terminal.command(id, owner(app), "counter", "after native edit", "selection-after");
    await app.setExtensionEnabled(owner(app), "terminal.ts", false);
    assert.deepEqual((await app.agentState(id))?.extensions, []);
});

test("append/message/append retains SDK ledger order after native admission and host rehydration", async () => {
    const { app, id } = await setup("manager-ledger-order");

    await app.terminal.command(id, owner(app), "weave", "write", "weave-write");
    await until(
        async () =>
            (await (await app.conversation(id)).context(context)).messages.some(
                (message) => message.role === "user" && message.content === "B",
            ),
        "passive custom message admitted",
    );
    await app.terminal.command(id, owner(app), "weave", "inspect", "weave-refresh");
    await app.terminal.evict(id, "resume");
    await app.terminal.command(id, owner(app), "weave", "inspect", "weave-rehydrated");
    assert.deepEqual(await values(app, id, "fixture-order"), [
        { steps: ["A", "B", "C"] },
        { steps: ["A", "B", "C"] },
        { steps: ["A", "B", "C"] },
    ]);
});

test("a due schedule after idle restart sees saved plugin tools in its first prepared request", async () => {
    const observed: string[][] = [];
    const provider = scriptedModel((request) => {
        observed.push(getCurrentTools(request.messages).map((tool) => tool.name));

        return observed.length === 1 && observed[0]!.includes("fixture_tool")
            ? fauxAssistantMessage([fauxToolCall("fixture_tool", { value: "scheduled" })], {
                  stopReason: "toolUse",
              })
            : fauxAssistantMessage([fauxText("Scheduled native round finished")]);
    });
    const dataDir = join(root, "manager-idle-schedule");
    let app = await openApp(provider, dataDir);

    apps.add(app);
    const id = await newSession(app);

    await app.setExtensionEnabled(owner(app), "terminal.ts", true);
    await app.terminal.catalogue(id, owner(app));
    await app.harness.commit(async (tx) => {
        (await tx.doc(AgentDoc, id)).tools = ["fixture_tool"];
    }, context);
    await app.commands.schedule(id, owner(app), {
        when: "in 10m use the configured plugin tool",
        zone: "UTC",
    });
    assert.equal(app.isBusy(id), false);
    await app.close();
    app = await openApp(provider, dataDir, () => Date.now() + 11 * 60_000);
    apps.add(app);
    await until(
        () => observed.length > 0 && !app.isBusy(id),
        "scheduled round after restart",
        15000,
    );
    assert.ok(
        observed[0]!.includes("fixture_tool"),
        "tool catalogue must be installed before preparation, not in beforeRequest",
    );
    assert.equal(observed.length, 2);
    assert.match(
        JSON.stringify((await (await app.conversation(id)).context(context)).messages),
        /plugin result scheduled/,
    );
});

async function scheduledStartup(name: string, ignoreCancellation = false) {
    const folder = join(root, name);
    const provider = model();
    const dataDir = join(root, `${name}-data`);
    let app = await openApp(provider, dataDir);

    apps.add(app);
    mkdirSync(folder);
    writeFileSync(join(folder, "bridge-start-audit"), "");
    const id = await newSession(app, folder);

    await app.setExtensionEnabled(owner(app), "terminal.ts", true);
    await app.terminal.catalogue(id, owner(app));
    const schedule = await app.commands.schedule(id, owner(app), {
        when: "in 10m do not run cancelled work",
        zone: "UTC",
    });

    await app.close();
    writeFileSync(join(folder, "bridge-start-hold"), "");

    if (ignoreCancellation) {
        writeFileSync(join(folder, "bridge-start-ignore"), "");
    }

    app = await openApp(provider, dataDir, () => Date.now() + 11 * 60_000);
    apps.add(app);
    await until(() => app.terminal.dialogs(id, owner(app)).length > 0, "scheduled startup dialog");
    const pid = Number(
        readFileSync(join(folder, "bridge-start-pids"), "utf8").trim().split("\n").at(-1),
    );

    return { app, id, provider, schedule, pid };
}

test("cancelling a schedule also cancels its pending plugin startup before admission", async () => {
    const { app, id, provider, schedule, pid } = await scheduledStartup(
        "manager-schedule-startup-cancel",
    );
    const fallback = setTimeout(() => {
        if (alive(pid)) {
            process.kill(pid, "SIGKILL");
        }
    }, 1500);
    const began = Date.now();

    try {
        await app.commands.cancelSchedule(id, owner(app), schedule.id);
        await until(
            () => app.terminal.dialogs(id, owner(app)).length === 0,
            "cancelled schedule releases startup UI",
        );
        assert.ok(Date.now() - began < 1000, "cancellation must not wait for the startup handler");
        assert.equal(provider.state.callCount, 0);
    } finally {
        clearTimeout(fallback);
    }
});

test("server close reaps a scheduled startup even when its handler ignores dialog cancellation", async () => {
    const { app, provider, pid } = await scheduledStartup("manager-schedule-startup-close", true);
    const fallback = setTimeout(() => {
        if (alive(pid)) {
            process.kill(pid, "SIGKILL");
        }
    }, 1500);
    const began = Date.now();

    try {
        await app.close();
        assert.ok(
            Date.now() - began < 1000,
            "close must reap startup before awaiting durable shutdown",
        );
        assert.equal(alive(pid), false);
        assert.equal(provider.state.callCount, 0);
    } finally {
        clearTimeout(fallback);
    }
});

test("core and native-extension tool collisions fail with provenance before changing the native loadout", async () => {
    for (const name of ["bash", "schedule"]) {
        const { app } = await setup(`manager-tool-collision-${name}`);
        const folder = join(root, `tool-collision-${name}`);
        const marker = join(folder, "child-pid");

        mkdirSync(join(folder, ".git"), { recursive: true });
        mkdirSync(join(folder, ".pi", "extensions"), { recursive: true });
        writeFileSync(
            join(folder, ".pi", "extensions", "collision.ts"),
            `import { writeFileSync } from "node:fs";
            export default pi => {
                writeFileSync(${JSON.stringify(marker)}, String(process.pid));
                pi.registerTool({ name: ${JSON.stringify(name)}, description: "Conflicting plugin tool", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "must never replace native tool" }] }) });
            };`,
        );
        const id = await newSession(app, folder);

        await app.setProjectTrust(id, owner(app), "trust");
        const before = (await app.agentState(id))?.tools;

        await assert.rejects(
            app.terminal.catalogue(id, owner(app)),
            new RegExp(`tool ${name} collides with a native Pocket tool.*collision.ts`),
        );
        assert.deepEqual((await app.agentState(id))?.tools, before);
        const native = (await (await app.conversation(id)).agent(context)).tools.find(
            (tool) => tool.name === name,
        );

        assert.ok(native);
        assert.notEqual(native.description, "Conflicting plugin tool");
        const pid = Number(readFileSync(marker, "utf8"));

        await until(() => !alive(pid), "rejected collision host is reaped");
        await app.setExtensionEnabled(owner(app), "terminal.ts", false);
    }
});

test("stateful forks start as fork, while later idle rehydration and reload retain their distinct reasons", async () => {
    const { app, id } = await setup("manager-start-reasons");

    await app.terminal.command(id, owner(app), "counter", "inherited state", "reason-parent");
    await say(app, id, "native branch point");
    const answer = (
        await (await app.conversation(id)).entries({ order: "ascending" }, 100, undefined, context)
    ).items.find((entry) => entry.kind === "pi.assistant")!;
    const fork = await app.commands.fork(id, owner(app), { entryId: Number(answer.id) });
    const inherited = await app.harness.snapshot(TerminalStateDoc, fork.id, context);

    assert.ok(inherited, "the branch inherits terminal state before its first host starts");
    await app.terminal.command(fork.id, owner(app), "counter", "first fork command", "reason-fork");
    assert.deepEqual(await values(app, id, "fixture-start"), [{ reason: "new" }]);
    assert.deepEqual(await values(app, fork.id, "fixture-start"), [
        { reason: "new" },
        { reason: "fork" },
    ]);
    await app.terminal.evict(fork.id, "resume");
    await app.terminal.command(fork.id, owner(app), "counter", "idle rehydration", "reason-resume");
    assert.deepEqual((await values(app, fork.id, "fixture-start")).at(-1), { reason: "resume" });
    await app.reloadExtension("terminal.ts");
    assert.deepEqual((await values(app, fork.id, "fixture-start")).at(-1), { reason: "reload" });
    assert.deepEqual(await values(app, fork.id, "fixture-state"), [
        { count: 1, args: "inherited state" },
        { count: 2, args: "first fork command" },
        { count: 3, args: "idle rehydration" },
    ]);
});
