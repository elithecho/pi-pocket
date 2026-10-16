/** Actual local pi-goal through production Pocket dispatch. Run with PI_POCKET_GOAL_EXTENSION=/path/to/index.ts node --test test/terminal-goal-acceptance.ts. */
import {
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { TerminalStateDoc, TerminalWorkDoc } from "../src/server/docs.ts";

const path = process.env.PI_POCKET_GOAL_EXTENSION;

if (!path) {
    throw new Error(
        "Set PI_POCKET_GOAL_EXTENSION to the installed/local pi-goal entry; no package installation is performed.",
    );
}

writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR!, "settings.json"),
    JSON.stringify({ extensions: [resolve(path)] }),
);
const apps = new Set<App>();

after(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    cleanUp();
});

async function state(app: App, id: ConversationId) {
    const snapshot = await app.harness.snapshot(TerminalStateDoc, id, context);
    const last = snapshot?.entries
        .map((entry) => entry.sdk)
        .findLast(
            (entry) =>
                entry &&
                typeof entry === "object" &&
                !Array.isArray(entry) &&
                entry.type === "custom" &&
                entry.customType === "pi-goal",
        );

    assert.ok(last && typeof last === "object" && !Array.isArray(last));
    const data = last.data;

    assert.ok(data && typeof data === "object" && !Array.isArray(data));
    const goal = data.goal;

    assert.ok(goal && typeof goal === "object" && !Array.isArray(goal));

    return goal;
}

async function send(app: App, id: ConversationId, text: string) {
    return app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });
}

test("actual /goal starts work, continues, completes through its registered tool and stops", async () => {
    let calls = 0;
    const model = scriptedModel(() => {
        calls++;

        if (calls === 2) {
            return fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([
            fauxText(calls === 1 ? "more work remains" : "completed and verified"),
        ]);
    });
    const app = await openApp(model, join(root, "actual-goal-complete"));

    apps.add(app);
    const id = await newSession(app);

    await app.setExtensionEnabled(owner(app), "terminal.ts", true);
    assert.equal(
        (await app.terminal.catalogue(id, owner(app))).some((command) => command.name === "goal"),
        true,
    );
    await send(app, id, "/goal complete the isolated acceptance fixture");
    await until(
        async () => !app.isBusy(id) && (await state(app, id)).status === "complete",
        "actual pi-goal completion",
        20_000,
    );
    assert.equal(
        calls,
        3,
        "one initial answer, one continuation requesting completion, one tool follow-up",
    );
    const selected = (await (await app.conversation(id)).agent(context)).tools.map(
        (tool) => tool.name,
    );

    assert.equal(selected.includes("create_goal"), true);
    assert.equal(selected.includes("get_goal"), false);
    assert.equal(selected.includes("update_goal"), false);
    assert.equal(app.terminal.problem(id, owner(app)), null);
});

test("actual /goal pause works during a model request, then resume and restart preserve state", async () => {
    let release = () => {};

    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let calls = 0;
    const model = scriptedModel(async () => {
        calls++;

        if (calls === 1) {
            await gate;

            return fauxAssistantMessage([fauxText("current work finished")]);
        }

        if (calls === 2) {
            return fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([fauxText("finished")]);
    });
    const dataDir = join(root, "actual-goal-pause");
    let app = await openApp(model, dataDir);

    apps.add(app);
    const id = await newSession(app);

    try {
        await app.setExtensionEnabled(owner(app), "terminal.ts", true);
        await send(app, id, "/goal exercise pause and resume");
        await until(() => calls === 1 && app.isBusy(id), "the first request waiting");
        await send(app, id, "/goal pause");
        assert.equal((await state(app, id)).status, "paused");
        release();
        await until(() => !app.isBusy(id), "the paused goal's current request to finish");
        assert.equal(calls, 1, "pause prevents the autonomous continuation");
        const tokens = (await state(app, id)).tokensUsed;

        await app.close();
        app = await openApp(model, dataDir);
        apps.add(app);
        await app.terminal.catalogue(id, owner(app));
        assert.equal((await state(app, id)).status, "paused");
        assert.equal((await state(app, id)).tokensUsed, tokens);
        await send(app, id, "/goal resume");
        await until(
            async () => !app.isBusy(id) && (await state(app, id)).status === "complete",
            "resumed goal completion",
            20_000,
        );
        assert.equal(calls, 3);
    } finally {
        release();
    }
});

test("explicit extension reload pauses an active goal while its model request is still running", async () => {
    let release = () => {};

    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let calls = 0;
    const model = scriptedModel(async () => {
        calls++;
        await gate;

        return fauxAssistantMessage([fauxText("Interrupted active-goal work finished")]);
    });
    const app = await openApp(model, join(root, "actual-goal-active-reload"));

    apps.add(app);
    const id = await newSession(app);

    try {
        await app.setExtensionEnabled(owner(app), "terminal.ts", true);
        await send(app, id, "/goal exercise active reload");
        await until(() => calls === 1 && app.isBusy(id), "active goal request");
        assert.equal((await state(app, id)).status, "active");
        await app.reloadExtension("terminal.ts");
        assert.equal((await state(app, id)).status, "paused");
        release();
        await until(() => !app.isBusy(id), "request ends without continuation");
        assert.equal(calls, 1);
        assert.equal((await state(app, id)).status, "paused");
    } finally {
        release();
    }
});

test("a server restart pauses an active goal before resuming the interrupted native model task", async () => {
    let release = () => {};

    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let calls = 0;
    const model = scriptedModel(async (_request, options) => {
        calls++;

        if (calls === 1) {
            // A provider must release its transport when shutdown aborts the request.
            await new Promise<void>((resolve) => {
                if (options?.signal?.aborted) {
                    resolve();

                    return;
                }

                options?.signal?.addEventListener("abort", () => resolve(), { once: true });
                void gate.then(resolve);
            });
        }

        return fauxAssistantMessage([fauxText("Recovered native work finished")]);
    });
    const dataDir = join(root, "actual-goal-active-restart");
    let app = await openApp(model, dataDir);

    apps.add(app);
    const id = await newSession(app);

    try {
        await app.setExtensionEnabled(owner(app), "terminal.ts", true);
        await send(app, id, "/goal exercise active server restart");
        await until(() => calls === 1 && app.isBusy(id), "active goal request before restart");
        assert.equal((await state(app, id)).status, "active");
        await app.close();
        release();
        app = await openApp(model, dataDir);
        apps.add(app);
        await until(
            () => !app.isBusy(id),
            "native request recovered without autonomous continuation",
            20_000,
        );
        assert.equal((await state(app, id)).status, "paused");
        assert.equal(
            calls,
            2,
            "only the interrupted native request is retried, not autonomous goal work",
        );
        assert.equal(app.terminal.problem(id, owner(app)), null);
    } finally {
        release();
    }
});

test("actual token budget exhaustion produces one wrap-up turn and no continuing goal loop", async () => {
    let calls = 0;
    const model = scriptedModel(() => {
        calls++;

        return fauxAssistantMessage([
            fauxText("A bounded response with enough tokens to exhaust the tiny explicit budget"),
        ]);
    });
    const app = await openApp(model, join(root, "actual-goal-budget"));

    apps.add(app);
    const id = await newSession(app);

    await app.setExtensionEnabled(owner(app), "terminal.ts", true);
    await send(app, id, "/goal --tokens 1 exercise an explicit token budget");
    await until(
        async () => !app.isBusy(id) && (await state(app, id)).status === "budget_limited",
        "the actual budget limit",
        20_000,
    );
    const goal = await state(app, id);

    assert.equal(goal.tokenBudget, 1);
    assert.ok(typeof goal.tokensUsed === "number" && goal.tokensUsed >= 1);
    assert.equal(calls, 2, "one pursuing turn and one budget wrap-up turn");
});

test("actual pi-goal yields to pending user input rather than queuing an unwanted continuation", async () => {
    let release = () => {};

    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let calls = 0;
    const observed: string[] = [];
    const provider = scriptedModel(async (request) => {
        calls++;
        observed.push(lastText(request as never).text);

        if (calls === 1) {
            await gate;
        }

        if (calls === 2) {
            return fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([fauxText("Handled the queued user work")]);
    });
    const app = await openApp(provider, join(root, "actual-goal-user-priority"));

    apps.add(app);
    const id = await newSession(app);

    try {
        await app.setExtensionEnabled(owner(app), "terminal.ts", true);
        await send(app, id, "/goal respect pending user work");
        await until(() => calls === 1 && app.isBusy(id), "first goal request busy");
        await send(app, id, "manual next");
        release();
        await until(
            async () => !app.isBusy(id) && (await state(app, id)).status === "complete",
            "queued user handled then goal completed",
            20000,
        );
        assert.equal(calls, 3);
        assert.match(observed[1]!, /manual next/);
        const entries = (await app.harness.snapshot(TerminalStateDoc, id, context))!.entries;
        const continuations = entries.filter(
            ({ sdk }) =>
                sdk &&
                typeof sdk === "object" &&
                !Array.isArray(sdk) &&
                sdk.type === "custom_message" &&
                sdk.customType === "pi-goal-event" &&
                sdk.details &&
                typeof sdk.details === "object" &&
                !Array.isArray(sdk.details) &&
                sdk.details.kind === "continuation",
        );

        assert.equal(continuations.length, 0);
    } finally {
        release();
    }
});

test("spend exhaustion blocks actual goal continuation and Stop cancels it before a budget increase", async () => {
    let release = () => {};

    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let calls = 0;
    const provider = scriptedModel(async () => {
        calls++;
        await gate;

        return fauxAssistantMessage([
            fauxText("Work remains but continuation must respect spend and stop"),
        ]);
    });
    const app = await openApp(provider, join(root, "actual-goal-spend-stop"));

    apps.add(app);
    const id = await newSession(app);

    try {
        await app.setExtensionEnabled(owner(app), "terminal.ts", true);
        // Count existing spend before the goal starts: this isolates outbox admission from the
        // separate native policy that aborts a run when newly incurred usage crosses its limit.
        await recordCost(app, id, 1);
        await until(
            () => app.spend.personSpent(owner(app).id) >= 1,
            "existing spend fully counted",
        );
        await send(app, id, "/goal respect spend and stop");
        await until(() => calls === 1 && app.isBusy(id), "goal before limit");
        await app.spend.setSessionBudget(owner(app), id, 0.5);
        release();
        await until(
            async () =>
                !app.isBusy(id) &&
                Object.values(
                    (await app.harness.snapshot(TerminalWorkDoc, id, context))!.outbox,
                ).some((intent) => intent.status === "blocked"),
            "continuation held by spend",
        );
        assert.equal(calls, 1);
        assert.match(app.terminal.problem(id, owner(app)) ?? "", /spend limit/);
        await app.commands.abort(id, owner(app));
        await app.spend.setSessionBudget(owner(app), id, null);
        await app.terminal.drain(id);
        await send(app, id, "/goal status");
        assert.equal(calls, 1);
        assert.equal((await state(app, id)).status, "paused");
        const intents = Object.values(
            (await app.harness.snapshot(TerminalWorkDoc, id, context))!.outbox,
        );

        assert.equal(
            intents.some((intent) => intent.status === "cancelled"),
            true,
        );
        assert.equal(
            intents.some((intent) => intent.status === "pending" || intent.status === "blocked"),
            false,
        );
    } finally {
        release();
    }
});

test("actual goal pause remains usable while a registered plugin tool is waiting for its owner", async () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR!;

    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ extensions: [resolve(path), join(agentDir, "busy-tool-fixture.ts")] }),
    );
    writeFileSync(
        join(agentDir, "busy-tool-fixture.ts"),
        `export default pi => pi.registerTool({
        name: "wait_for_owner", description: "Temporary tool-context concurrency fixture", parameters: { type: "object", properties: {} },
        execute: async (_id, _args, _signal, _update, ctx) => {
            await ctx.ui.confirm("Tool busy", "Goal commands must remain usable during tool execution");
            return { content: [{ type: "text", text: "Owner released the busy tool" }] };
        }
    });`,
    );
    let calls = 0;
    const provider = scriptedModel(() => {
        calls++;

        return calls === 1
            ? fauxAssistantMessage([fauxToolCall("wait_for_owner", {})], { stopReason: "toolUse" })
            : fauxAssistantMessage([fauxText("Tool finished while the goal is paused")]);
    });
    const app = await openApp(provider, join(root, "actual-goal-tool-busy-pause"));

    apps.add(app);
    const id = await newSession(app);

    await app.setExtensionEnabled(owner(app), "terminal.ts", true);
    await send(app, id, "/goal remain pausable during a tool");
    await until(
        () =>
            app.isBusy(id) &&
            app.terminal.dialogs(id, owner(app)).some((dialog) => dialog.title === "Tool busy"),
        "registered plugin tool waiting",
    );
    await send(app, id, "/goal pause");
    assert.equal((await state(app, id)).status, "paused");
    assert.equal(app.isBusy(id), true);
    const dialog = app.terminal
        .dialogs(id, owner(app))
        .find((dialog) => dialog.title === "Tool busy")!;

    await app.terminal.answer(id, owner(app), dialog.id, false);
    await until(() => !app.isBusy(id), "paused goal's native tool round finishes");
    assert.equal(calls, 2);
    assert.equal((await state(app, id)).status, "paused");
    const messages = (await (await app.conversation(id)).context(context)).messages;

    assert.match(JSON.stringify(messages), /Owner released the busy tool/);
    assert.equal(
        Object.values((await app.harness.snapshot(TerminalWorkDoc, id, context))!.outbox).every(
            (intent) => intent.status === "delivered",
        ),
        true,
    );
});
