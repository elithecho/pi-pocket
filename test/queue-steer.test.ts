// Queue promotion changes delivery in place, not by withdrawing and resubmitting messages.
import {
    type App,
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { InboxDoc, type ConversationId } from "@earendil-works/pi-durable";

let app: App;

before(async () => {
    app = await openApp(
        scriptedModel((request) => {
            const { role, text } = lastText(request as never);
            const slow = /pause (\d+)/.exec(text);

            if (role === "user" && slow) {
                return fauxAssistantMessage(
                    [fauxToolCall("bash", { command: `sleep ${slow[1]}` })],
                    {
                        stopReason: "toolUse",
                    },
                );
            }

            return fauxAssistantMessage([
                fauxText(role === "toolResult" ? "old final answer" : `echo: ${text}`),
            ]);
        }),
    );
});
after(async () => {
    await app?.close();
    cleanUp();
});

async function busy(seconds = 30) {
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: `pause ${seconds}`, requestId: "start" });
    await until(
        async () => (await modelTexts(app, id)).some((text) => text.includes(`sleep ${seconds}`)),
        "tool round started",
    );

    return id;
}

const inbox = (id: ConversationId) => app.harness.snapshot(InboxDoc, id, context);

async function queued(id: ConversationId, text: string, mode: "followUp" | "steer" = "followUp") {
    return app.commands.submit(id, owner(app), { text, mode, requestId: crypto.randomUUID() });
}

test("single and all promotion preserve IDs, content, order, receipts and attribution; retries are no-ops", async () => {
    const id = await busy();

    try {
        const first = await queued(id, "first");
        const second = await queued(id, "second");

        await queued(id, "already steering", "steer");
        await (await app.harness.conversation(id, context))!.submit(
            { type: "write", entry: { kind: "test.note", data: {} } },
            context,
        );
        const before = (await inbox(id))!.items;
        const record = await app.harness.commit(
            (tx) => tx.submissionByRequest(id, first.requestId),
            context,
        );
        const by = app.attribution.knownSubmitter(Number(first.submissionId));

        assert.equal(
            await app.commands.promoteQueued(id, owner(app), Number(first.submissionId)),
            1,
        );
        assert.deepEqual(
            (await inbox(id))!.items,
            before.map((item) =>
                item.id === first.submissionId ? { ...item, mode: "steer" } : item,
            ),
        );
        assert.equal(await app.commands.promoteQueued(id, owner(app)), 1);
        assert.deepEqual(
            (await inbox(id))!.items,
            before.map((item) => (item.mode === "followUp" ? { ...item, mode: "steer" } : item)),
        );
        assert.equal(await app.commands.promoteQueued(id, owner(app)), 0);
        assert.equal(
            await app.commands.promoteQueued(id, owner(app), Number(second.submissionId)),
            0,
        );
        assert.equal(await app.commands.promoteQueued(id, owner(app), Number.MAX_SAFE_INTEGER), 0);
        assert.deepEqual(
            await app.harness.commit((tx) => tx.submissionByRequest(id, first.requestId), context),
            record,
        );
        assert.equal(app.attribution.knownSubmitter(Number(first.submissionId)), by);
    } finally {
        await app.commands.abort(id, owner(app));
    }
});

test("promoted input reaches the post-tool steering boundary before the old final answer", async () => {
    const id = await busy(1);
    const sent = await queued(id, "promoted during tool round");

    assert.equal(await app.commands.promoteQueued(id, owner(app)), 1);
    await (await app.harness.submission(sent.submissionId, context))!.wait(context);
    const texts = (await modelTexts(app, id)).join("\n");

    assert.match(texts, /echo:.*promoted during tool round/);
    assert.doesNotMatch(texts, /old final answer/);
    assert.equal(await app.commands.promoteQueued(id, owner(app), Number(sent.submissionId)), 0);
});

test("permissions, malformed IDs and cross-session IDs cannot promote another queue", async () => {
    const id = await busy();
    const other = await newSession(app);
    const viewer = app.config.addUser("Viewer", "viewer").user;
    const guest = app.config.addUser("Guest", "guest").user;
    const scoped = app.config.addUser("Scoped", "guest", [String(other)]).user;

    try {
        const sent = await queued(id, "protected");
        const before = await inbox(id);

        for (const value of [null, "1", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
            await assert.rejects(
                app.commands.promoteQueued(id, owner(app), value),
                /positive safe integer/,
            );
        }

        await assert.rejects(app.commands.promoteQueued(id, viewer), /not steer/);
        await assert.rejects(app.commands.promoteQueued(id, scoped), /not shared/);
        assert.equal(
            await app.commands.promoteQueued(other, owner(app), Number(sent.submissionId)),
            0,
        );
        await app.collab.turns(id, owner(app), { action: "on" });
        await assert.rejects(app.commands.promoteQueued(id, guest), /driving|wheel/);
        assert.deepEqual(await inbox(id), before);
    } finally {
        await app.commands.abort(id, owner(app));
    }
});

test("stranded idle follow-ups are not mutated or restarted; stale IDs still no-op", async () => {
    const id = await newSession(app);

    await app.harness.commit(async (tx) => {
        const queue = await tx.doc(InboxDoc, id);
        const record = await tx.createSubmission({
            conversationId: id,
            type: "input",
            status: "queued",
        });

        queue.items.push({ id: record.id, mode: "followUp", content: "stranded after failure" });
    }, context);
    const before = await inbox(id);

    await assert.rejects(app.commands.promoteQueued(id, owner(app)), /Pi is not running/);
    assert.deepEqual(await inbox(id), before);
    assert.equal(app.isBusy(id), false);
    assert.equal(await app.commands.promoteQueued(id, owner(app), Number.MAX_SAFE_INTEGER), 0);
    await app.commands.abort(id, owner(app));
});
