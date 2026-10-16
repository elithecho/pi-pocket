// Real Pocket-owned persistence/admission, including both outbox crash windows and stale operation rejection.
import {
    cleanUp,
    context,
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
import { join } from "node:path";
import { after, test } from "node:test";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { TerminalStateDoc, TerminalWorkDoc } from "../src/server/docs.ts";
import { TerminalStore } from "../src/server/terminal/store.ts";
import type { HostCustomEntry, HostLogEntry } from "../src/server/terminal/protocol.ts";

const apps = new Set<App>();

after(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    cleanUp();
});

async function setup(name: string) {
    const dataDir = join(root, name);
    const model = scriptedModel();
    const app = await openApp(model, dataDir);

    apps.add(app);
    const id = await newSession(app);

    return { app, id, model, dataDir, store: new TerminalStore(app) };
}

function sdk(id: string, content?: string): HostCustomEntry {
    const common = {
        id,
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: "generic-example",
    };

    return content === undefined
        ? { ...common, type: "custom", data: { value: "saved" } }
        : {
              ...common,
              type: "custom_message",
              content,
              display: true,
              details: { value: "metadata" },
          };
}

function combined(operation = "command", hostContent = "generic plugin message"): HostLogEntry[] {
    const custom = sdk("message", hostContent);

    assert.equal(custom.type, "custom_message");

    if (custom.type !== "custom_message") {
        throw new Error("Invalid fixture");
    }

    return [
        { seq: 1, operation, effect: { kind: "entry", entry: sdk("state"), after: null } },
        {
            seq: 2,
            operation,
            effect: {
                kind: "message",
                content: hostContent,
                custom,
                trigger: true,
                delivery: "followUp",
                expand: false,
                after: null,
            },
        },
        { seq: 3, operation, effect: { kind: "complete", result: { answer: "accepted" } } },
    ];
}

async function userMessages(app: App, id: ConversationId) {
    return (await (await app.conversation(id)).context(context)).messages.filter(
        (message) => message.role === "user",
    );
}

test("a committed prefix applies once, returns recorded results, and admits one attributed custom message", async () => {
    const { app, id, store, model } = await setup("atomic-prefix");
    const alice = app.config.addUser("Alice", "guest").user;

    assert.deepEqual(await store.begin(id, "command", alice, "host"), {
        status: "started",
        epoch: 0,
    });
    await assert.rejects(store.begin(id, "command", alice, "host"), /already running/);
    const committed = await store.apply(id, "host", combined());

    assert.equal(committed.through, 3);
    assert.equal(committed.effects.length, 3);
    assert.deepEqual(await store.apply(id, "host", combined()), { through: 3, effects: [] });
    assert.equal((await app.harness.snapshot(TerminalStateDoc, id, context))?.entries.length, 2);
    assert.deepEqual(await store.result(id, "command"), { answer: "accepted" });
    assert.deepEqual(await store.begin(id, "command", alice, "new-host"), {
        status: "done",
        result: { answer: "accepted" },
    });
    await assert.rejects(store.begin(id, "command", owner(app), "host"), { status: 403 });
    assert.deepEqual(await store.drain(id), { delivered: 1, blocked: [] });
    await until(
        () => !app.isBusy(id) && model.state.callCount === 1,
        "the single admitted message to finish",
    );
    assert.equal(
        (await userMessages(app, id)).filter((message) =>
            JSON.stringify(message.content).includes("generic plugin message"),
        ).length,
        1,
    );
    assert.equal(app.attribution.requesterOf(id), alice.id);
    await recordCost(app, id, 0.5);
    await until(
        () => app.spend.personSpent(alice.id) === 0.5,
        "extension work to be billed to its requester",
    );
    assert.deepEqual(await store.drain(id), { delivered: 0, blocked: [] });
});

test("commit failure rolls back the entire prefix and uncertain handlers are not retried on a fresh host", async () => {
    const { app, id, store, model } = await setup("prefix-rollback");

    await store.begin(id, "command", owner(app), "host");
    await assert.rejects(
        store.apply(id, "host", combined(), async () => {
            throw new Error("injected storage boundary failure");
        }),
        /injected storage boundary failure/,
    );
    assert.equal(
        (await app.harness.snapshot(TerminalStateDoc, id, context))?.entries.length ?? 0,
        0,
    );
    assert.deepEqual((await app.harness.snapshot(TerminalWorkDoc, id, context))?.outbox, {});
    await assert.rejects(store.begin(id, "command", owner(app), "fresh-host"), /not replayed/);
    assert.equal(
        (await app.harness.snapshot(TerminalWorkDoc, id, context))?.operations.command?.status,
        "interrupted",
    );
    assert.equal(model.state.callCount, 0);
});

test("state and pending intents recover after commit-before-admission without a second conversation store", async () => {
    let { app, id, store, model, dataDir } = await setup("recover-before-admission");

    await store.begin(id, "command", owner(app), "host");
    await store.apply(id, "host", combined());
    await app.close();
    app = await openApp(model, dataDir);
    apps.add(app);
    store = new TerminalStore(app);
    assert.equal((await app.harness.snapshot(TerminalStateDoc, id, context))?.entries.length, 2);
    assert.equal(model.state.callCount, 0);
    assert.deepEqual(await store.drain(id), { delivered: 1, blocked: [] });
    await until(() => !app.isBusy(id) && model.state.callCount === 1, "recovered admission");
    assert.equal(
        (await userMessages(app, id)).filter((message) =>
            JSON.stringify(message.content).includes("generic plugin message"),
        ).length,
        1,
    );
});

test("admission-before-delivery-mark recovery finds the stable native request even when new work is now spend-blocked", async () => {
    let { app, id, store, model, dataDir } = await setup("recover-after-admission");

    await store.begin(id, "command", owner(app), "host");
    await store.apply(id, "host", combined());
    const [intent] = Object.values(
        (await app.harness.snapshot(TerminalWorkDoc, id, context))!.outbox,
    );

    assert.ok(intent);
    // Emulate process loss after native admission but before TerminalStore's delivered mark.
    await app.commands.submitTerminal(id, owner(app), {
        key: intent.key,
        content: "generic plugin message",
        trigger: true,
        delivery: "followUp",
        expand: false,
    });
    await until(() => !app.isBusy(id) && model.state.callCount === 1, "the admitted request");
    await recordCost(app, id, 1);
    await app.spend.setSessionBudget(owner(app), id, 0.5);
    await app.close();
    app = await openApp(model, dataDir);
    apps.add(app);
    store = new TerminalStore(app);
    assert.deepEqual(await store.drain(id), { delivered: 1, blocked: [] });
    assert.equal(
        model.state.callCount,
        1,
        "recovery acknowledges the existing request instead of starting another",
    );
    assert.equal(
        (await userMessages(app, id)).filter((message) =>
            JSON.stringify(message.content).includes("generic plugin message"),
        ).length,
        1,
    );
    assert.equal(
        Object.values((await app.harness.snapshot(TerminalWorkDoc, id, context))!.outbox)[0]
            ?.status,
        "delivered",
    );
});

test("an acknowledged command prefix may checkpoint a pending tool, but host failure leaves that tool visibly interrupted", async () => {
    const { app, id, store } = await setup("overlapping-checkpoint");

    await store.begin(id, "tool", owner(app), "host");
    await store.begin(id, "command", owner(app), "host");
    await store.apply(id, "host", [
        {
            seq: 1,
            operation: "tool",
            effect: { kind: "entry", entry: sdk("tool-state"), after: null },
        },
        {
            seq: 2,
            operation: "command",
            effect: { kind: "complete", result: "read committed tool state" },
        },
    ]);
    await store.interrupt(id, "host", "tool failed after a checkpoint");
    const work = await app.harness.snapshot(TerminalWorkDoc, id, context);

    assert.equal(work?.operations.tool?.status, "interrupted");
    assert.equal(work?.operations.command?.status, "done");
    assert.equal((await app.harness.snapshot(TerminalStateDoc, id, context))?.entries.length, 1);
    await assert.rejects(
        store.apply(id, "host", [
            {
                seq: 3,
                operation: "tool",
                effect: {
                    kind: "message",
                    content: "must not run",
                    trigger: true,
                    delivery: "followUp",
                    expand: false,
                    after: null,
                },
            },
        ]),
        /stale, interrupted/,
    );
    assert.deepEqual((await app.harness.snapshot(TerminalWorkDoc, id, context))?.outbox, {});
});

test("stop cancels old-epoch intents and rejects stale replies without deadlocking interruption cleanup", async () => {
    const { app, id, store, model } = await setup("stop-epoch");

    await store.begin(id, "command", owner(app), "host");
    await store.apply(id, "host", combined());
    await store.begin(id, "waiting", owner(app), "host");
    await store.stop(id, async () => {
        // A native tool's cancellation cleanup can require this store after abort was initiated.
        await store.interrupt(id, "host", "cancelled");
        await (await app.conversation(id)).abort(context);
    });
    assert.deepEqual(await store.drain(id), { delivered: 0, blocked: [] });
    assert.equal(model.state.callCount, 0);
    assert.equal((await app.harness.snapshot(TerminalWorkDoc, id, context))?.epoch, 1);
    await assert.rejects(
        store.apply(id, "host", [
            { seq: 4, operation: "waiting", effect: { kind: "complete", result: null } },
        ]),
        /stale, interrupted/,
    );
});

test("old completed receipts leave a bounded hot index without losing results or permitting unsafe retries", async () => {
    const { app, id, store, model } = await setup("bounded-receipts");

    for (let index = 0; index < 80; index++) {
        const key = `op-${index}`;

        await store.begin(id, key, owner(app), "host");
        await store.apply(id, "host", [
            { seq: index + 1, operation: key, effect: { kind: "complete", result: { index } } },
        ]);
    }

    assert.ok(
        Object.keys((await app.harness.snapshot(TerminalWorkDoc, id, context))!.operations)
            .length <= 64,
    );
    assert.deepEqual(await store.result(id, "op-0"), { index: 0 });
    assert.deepEqual(await store.begin(id, "op-0", owner(app), "new-host"), {
        status: "done",
        result: { index: 0 },
    });
    assert.equal(model.state.callCount, 0);
});

test("one drain admits at most one bounded batch without dropping later pending intents", async () => {
    const { app, id, store, model } = await setup("bounded-drain");
    const log: HostLogEntry[] = Array.from({ length: 80 }, (_, index) => ({
        seq: index + 1,
        operation: "batch",
        effect: {
            kind: "message",
            content: `batch ${index}`,
            trigger: true,
            delivery: "followUp",
            expand: false,
            after: null,
        },
    }));

    log.push({ seq: 81, operation: "batch", effect: { kind: "complete", result: null } });
    await store.begin(id, "batch", owner(app), "host");
    await store.apply(id, "host", log);
    assert.deepEqual(await store.drain(id), { delivered: 32, blocked: [] });
    assert.equal(
        Object.values((await app.harness.snapshot(TerminalWorkDoc, id, context))!.outbox).filter(
            (intent) => intent.status === "pending",
        ).length,
        48,
    );
    assert.equal(await store.hasPending(id), true);
    assert.deepEqual(await store.drain(id), { delivered: 32, blocked: [] });
    assert.deepEqual(await store.drain(id), { delivered: 16, blocked: [] });
    assert.equal(await store.hasPending(id), false);
    assert.ok(
        Object.keys((await app.harness.snapshot(TerminalWorkDoc, id, context))!.outbox).length <=
            64,
    );
    await until(
        () => !app.isBusy(id) && model.state.callCount === 80,
        "all eighty uniquely admitted requests",
        30_000,
    );
    assert.equal((await userMessages(app, id)).length, 80);
});

test("pending-effect and unfinished-operation limits fail atomically instead of dropping work", async () => {
    const { app, id, store, model } = await setup("pending-limits");
    const log: HostLogEntry[] = Array.from({ length: 257 }, (_, index) => ({
        seq: index + 1,
        operation: "overflow",
        effect: {
            kind: "message",
            content: "too much queued work",
            trigger: true,
            delivery: "followUp",
            expand: false,
            after: null,
        },
    }));

    await store.begin(id, "overflow", owner(app), "host");
    await assert.rejects(store.apply(id, "host", log), /Too many pending/);
    assert.deepEqual((await app.harness.snapshot(TerminalWorkDoc, id, context))?.outbox, {});
    await store.interrupt(id, "host", "overflow rejected");

    for (let index = 0; index < 64; index++) {
        await store.begin(id, `pending-${index}`, owner(app), "host");
    }

    await assert.rejects(
        store.begin(id, "one-too-many", owner(app), "host"),
        /Too many unfinished/,
    );
    assert.equal(
        Object.values(
            (await app.harness.snapshot(TerminalWorkDoc, id, context))!.operations,
        ).filter((operation) => operation.status === "started").length,
        64,
    );
    assert.equal(model.state.callCount, 0);
});

test("long multiline extension instructions do not launch a separate title-model request", async () => {
    const { app, id, model } = await setup("extension-title-boundary");
    const text =
        "one two three four five six seven eight nine ten eleven\nmore extension instructions on another line";
    const submitted = await app.commands.submitTerminal(id, owner(app), {
        key: "long-extension-message",
        content: text,
        trigger: true,
        delivery: "followUp",
        expand: false,
    });

    await (await app.harness.submission(submitted.submissionId, context))!.wait(context);
    assert.equal(model.state.callCount, 1);
    assert.match(
        app.sessionMeta(id)?.title ?? "",
        /^one two three four five six seven eight nine ten eleven/,
    );
    assert.equal(
        (await userMessages(app, id))[0]?.content,
        text,
        "only the title preview is shortened, never the model's actual input",
    );
});

test("passive custom messages enter context once without launching a model or losing their metadata", async () => {
    const { app, id, store, model } = await setup("passive-admission");
    const log = combined("passive", "passive-only content");
    const message = log[1]!.effect;

    assert.equal(message.kind, "message");

    if (message.kind === "message") {
        message.trigger = false;
    }

    await store.begin(id, "passive", owner(app), "host");
    await store.apply(id, "host", log);
    assert.deepEqual(await store.drain(id), { delivered: 1, blocked: [] });
    assert.equal(model.state.callCount, 0);
    const messages = await userMessages(app, id);

    assert.deepEqual(
        messages.map((message) => message.content),
        ["passive-only content"],
    );
    const rows = await (await app.conversation(id)).entries({}, 100, undefined, context);
    const custom = rows.items.find((entry) => entry.kind === "pocket.terminal-message");

    assert.match(JSON.stringify(custom?.data), /"value":"metadata"/);
    assert.equal((await app.harness.snapshot(TerminalStateDoc, id, context))?.entries.length, 2);
});

test("a committed intent rechecks driver rights at admission rather than using the command's old authority", async () => {
    const { app, id, store, model } = await setup("driver-revoked");
    const guest = app.config.addUser("Guest", "guest").user;

    await store.begin(id, "command", guest, "host");
    await store.apply(id, "host", combined());
    await app.collab.turns(id, owner(app), { action: "on" });
    const result = await store.drain(id);

    assert.equal(result.delivered, 0);
    assert.match(result.blocked[0]!, /driving/);
    assert.equal(model.state.callCount, 0);
    assert.equal(
        Object.values((await app.harness.snapshot(TerminalWorkDoc, id, context))!.outbox)[0]
            ?.status,
        "blocked",
    );
});

test("viewer/non-driver requests fail and spend-blocked effects remain visible and safely retryable", async () => {
    const { app, id, store, model } = await setup("policy-boundary");
    const viewer = app.config.addUser("Viewer", "viewer").user;
    const guest = app.config.addUser("Guest", "guest").user;

    await assert.rejects(store.begin(id, "viewer", viewer, "host"), { status: 403 });
    await app.collab.turns(id, owner(app), { action: "on" });
    await assert.rejects(store.begin(id, "non-driver", guest, "host"), { status: 409 });
    await store.begin(id, "command", owner(app), "host");
    await store.apply(id, "host", combined());
    await recordCost(app, id, 1);
    await app.spend.setSessionBudget(owner(app), id, 0.5);
    const blocked = await store.drain(id);

    assert.equal(blocked.delivered, 0);
    assert.match(blocked.blocked[0]!, /spend limit/);
    assert.equal(model.state.callCount, 0);
    assert.equal(
        Object.values((await app.harness.snapshot(TerminalWorkDoc, id, context))!.outbox)[0]
            ?.status,
        "blocked",
    );
    await app.spend.setSessionBudget(owner(app), id, null);
    assert.deepEqual(await store.drain(id), { delivered: 1, blocked: [] });
    await until(() => !app.isBusy(id) && model.state.callCount === 1, "the unblocked intent");
});

test("passive writes need neither a selected model nor available spend, but still require access and driver", async () => {
    for (const boundary of ["no-model", "spend"] as const) {
        const { app, id, store, model } = await setup(`passive-${boundary}`);

        if (boundary === "no-model") {
            await app.harness.commit(async (tx) => {
                delete (await tx.doc(AgentDoc, id)).model;
            }, context);
        } else {
            await recordCost(app, id, 1);
            await app.spend.setSessionBudget(owner(app), id, 0.5);
        }

        await store.begin(id, "command", owner(app), "host");
        await store.apply(
            id,
            "host",
            combined().map((item) =>
                item.effect.kind === "message"
                    ? { ...item, effect: { ...item.effect, trigger: false } }
                    : item,
            ),
        );
        assert.deepEqual(await store.drain(id), { delivered: 1, blocked: [] });
        assert.equal(model.state.callCount, 0);
        assert.equal(
            (await userMessages(app, id)).filter((message) =>
                JSON.stringify(message.content).includes("generic plugin message"),
            ).length,
            1,
        );
    }
});
