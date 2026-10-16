// Native persistence/admission invariants the terminal bridge must preserve. No live data or provider calls.
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
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { TerminalStateDoc, TerminalWorkDoc } from "../src/server/docs.ts";

const apps = new Set<App>();

after(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    cleanUp();
});

async function history(app: App, id: ConversationId) {
    return (
        await (await app.conversation(id)).entries({ order: "ascending" }, 200, undefined, context)
    ).items;
}

async function documents(app: App, id: ConversationId) {
    await app.harness.commit(async (tx) => {
        await tx.doc(TerminalStateDoc, id);
        await tx.doc(TerminalWorkDoc, id);
    }, context);
}

test("extension state and outbox commit together, and asOf forks inherit state but no autonomous intents", async () => {
    const app = await openApp(scriptedModel(), join(root, "state-forks"));

    apps.add(app);
    const id = await newSession(app);

    await documents(app, id);
    await say(app, id, "before plugin state");
    const firstAnswer = (await history(app, id)).find((entry) => entry.kind === "pi.assistant");

    assert.ok(firstAnswer);
    await app.harness.commit(async (tx) => {
        const state = await tx.doc(TerminalStateDoc, id);
        const work = await tx.doc(TerminalWorkDoc, id);

        state.entries.push({
            sdk: { type: "custom", id: "state-one", customType: "example", data: { value: "one" } },
            after: String(firstAnswer.id),
        });
        work.outbox.one = {
            status: "pending",
            by: owner(app).id,
            epoch: 0,
            key: "one",
            content: "continue",
            trigger: true,
            delivery: "followUp",
            expand: false,
        };
    }, context);
    assert.equal((await app.harness.snapshot(TerminalStateDoc, id, context))?.entries.length, 1);
    assert.equal(
        (await app.harness.snapshot(TerminalWorkDoc, id, context))?.outbox.one?.status,
        "pending",
    );
    assert.equal(
        (await app.harness.snapshotAsOf(TerminalStateDoc, id, firstAnswer.id, context))?.entries
            .length,
        0,
    );
    await say(app, id, "after plugin state");
    const secondAnswer = (await history(app, id))
        .filter((entry) => entry.kind === "pi.assistant")
        .at(-1);

    assert.ok(secondAnswer);
    const early = await app.commands.fork(id, owner(app), { entryId: Number(firstAnswer.id) });
    const later = await app.commands.fork(id, owner(app), { entryId: Number(secondAnswer.id) });

    await documents(app, later.id);
    assert.equal(
        (await app.harness.snapshot(TerminalStateDoc, early.id, context))?.entries.length,
        0,
    );
    assert.equal(
        (await app.harness.snapshot(TerminalStateDoc, later.id, context))?.entries.length,
        1,
    );
    assert.deepEqual((await app.harness.snapshot(TerminalWorkDoc, later.id, context))?.outbox, {});
    await app.harness.commit(async (tx) => {
        (await tx.doc(TerminalStateDoc, id)).entries.push({
            sdk: { type: "custom", id: "future" },
            after: String(secondAnswer.id),
        });
    }, context);
    assert.equal(
        (await app.harness.snapshot(TerminalStateDoc, later.id, context))?.entries.length,
        1,
        "later parent writes cannot change the fork",
    );
});

test("a failed atomic effect commit exposes neither extension state nor its message intent", async () => {
    const app = await openApp(scriptedModel(), join(root, "atomic-failure"));

    apps.add(app);
    const id = await newSession(app);

    await documents(app, id);
    await assert.rejects(
        app.harness.commit(async (tx) => {
            const state = await tx.doc(TerminalStateDoc, id);
            const work = await tx.doc(TerminalWorkDoc, id);

            state.entries.push({ sdk: { type: "custom", id: "rolled-back" }, after: null });
            work.outbox.bad = {
                status: "pending",
                by: owner(app).id,
                epoch: 0,
                key: "bad",
                content: "must not run",
                trigger: true,
                delivery: "followUp",
                expand: false,
            };

            throw new Error("injected effect commit failure");
        }, context),
        /injected effect commit failure/,
    );
    assert.deepEqual((await app.harness.snapshot(TerminalStateDoc, id, context))?.entries, []);
    assert.deepEqual((await app.harness.snapshot(TerminalWorkDoc, id, context))?.outbox, {});
});

test("busy conversations queue passive custom messages and deduplicate attributed triggering messages", async () => {
    let release = () => {};

    let entered = false;
    let stateSeenByModel = false;
    let app: App;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const model = scriptedModel(async (request) => {
        const text = lastText(request as never).text;

        if (text === "hold") {
            entered = true;
            await gate;
        }

        if (text.includes("triggered custom message")) {
            stateSeenByModel =
                (await app.harness.snapshot(TerminalStateDoc, id, context))?.statuses.example ===
                "committed";
        }

        return fauxAssistantMessage([fauxText("answer")]);
    });

    app = await openApp(model, join(root, "busy-placement"));
    apps.add(app);
    const id = await newSession(app);

    await documents(app, id);

    try {
        const started = await app.commands.submit(id, owner(app), {
            text: "hold",
            requestId: "hold",
        });

        await until(() => entered && app.isBusy(id), "the model to hold an active request");
        await app.harness.commit(async (tx) => {
            const state = await tx.doc(TerminalStateDoc, id);
            const work = await tx.doc(TerminalWorkDoc, id);

            state.statuses.example = "committed";
            state.entries.push({
                sdk: { type: "custom_message", id: "message", content: "triggered custom message" },
                after: null,
            });
            work.outbox.message = {
                status: "pending",
                by: owner(app).id,
                epoch: 0,
                key: "message",
                content: "triggered custom message",
                trigger: true,
                delivery: "followUp",
                expand: false,
            };
        }, context);
        const conversation = await app.conversation(id);
        const passive = await conversation.submit(
            {
                type: "write",
                requestId: "passive",
                entry: {
                    kind: "pocket.terminal-message",
                    model: [
                        { role: "user", content: "passive custom message", timestamp: Date.now() },
                    ],
                    data: { sdk: { type: "custom_message", customType: "example", display: true } },
                },
            },
            context,
        );

        assert.equal((await passive.status(context)).status, "queued");
        assert.doesNotMatch(
            JSON.stringify((await conversation.context(context)).messages),
            /passive custom message/,
        );
        const message = await app.commands.submit(
            id,
            owner(app),
            { text: "triggered custom message", requestId: "stable-effect-key" },
            "Pi extension",
        );
        const retried = await app.commands.submit(
            id,
            owner(app),
            { text: "triggered custom message", requestId: "stable-effect-key" },
            "Pi extension",
        );

        assert.equal(message.submissionId, retried.submissionId);
        release();
        await (await app.harness.submission(started.submissionId, context))!.wait(context);
        await passive.wait(context);
        await (await app.harness.submission(message.submissionId, context))!.wait(context);
        const messages = (await conversation.context(context)).messages.filter(
            (message) => message.role === "user",
        );

        assert.equal(
            messages.filter((message) =>
                JSON.stringify(message.content).includes("triggered custom message"),
            ).length,
            1,
        );
        assert.equal(
            messages.filter((message) =>
                JSON.stringify(message.content).includes("passive custom message"),
            ).length,
            1,
        );
        assert.equal(stateSeenByModel, true);
        assert.equal(model.state.callCount, 2, "the passive write starts no extra model turn");
    } finally {
        release();
    }
});
