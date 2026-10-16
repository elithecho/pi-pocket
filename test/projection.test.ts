import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { projectEntry, projectStats } from "../src/server/projection.ts";

const entry = (kind: string, message: unknown, id = 1) =>
    ({ id, conversationId: 2, kind, model: [message] }) as unknown as EntryRecord;

test("tool results count their images and leave the data out", () => {
    const message = {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "screenshot",
        content: [
            { type: "text", text: "captured" },
            { type: "image", data: "x".repeat(10_000), mimeType: "image/png" },
        ],
        isError: false,
    };
    const projected = projectEntry(entry("pi.tool-result", message));

    assert.ok(projected?.kind === "toolResult");
    assert.equal(projected.images, 1);
    assert.equal(projected.text, "captured");
    assert.ok(JSON.stringify(projected).length < 500);
    const plain = projectEntry(
        entry("pi.tool-result", { ...message, content: [{ type: "text", text: "ok" }] }),
    );

    assert.ok(plain?.kind === "toolResult" && plain.images === undefined);
});

test("stats add the cost of models and tools", () => {
    const usage = {
        models: {
            "a/b": {
                input: 100,
                output: 10,
                cacheRead: 300,
                cacheWrite: 100,
                cost: { total: 0.5 },
            },
        },
        tools: { t: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } },
    };
    const entries = [
        entry("pi.assistant", {
            role: "assistant",
            content: [],
            usage: { input: 10, output: 5, cacheRead: 80, cacheWrite: 5 },
            stopReason: "stop",
        }),
    ];
    const stats = projectStats(usage as never, entries);

    assert.equal(stats.cost, 0.75);
});

test("passive custom messages project generically only when displayed, without executing terminal renderers", () => {
    const passive = {
        ...entry("pocket.terminal-message", {
            role: "user",
            content: [
                { type: "text", text: "A plugin update <script>danger()</script>" },
                { type: "image", data: "x", mimeType: "image/png" },
            ],
            timestamp: 123,
        }),
        data: { custom: { type: "custom_message", customType: "arbitrary-plugin", display: true } },
    } as unknown as EntryRecord;

    assert.deepEqual(projectEntry(passive), {
        id: 1,
        kind: "extension",
        customType: "arbitrary-plugin",
        text: "A plugin update <script>danger()</script>",
        images: 1,
        at: 123,
    });
    assert.equal(
        projectEntry({
            ...passive,
            data: {
                custom: { type: "custom_message", customType: "arbitrary-plugin", display: false },
            },
        } as unknown as EntryRecord),
        undefined,
    );
});
