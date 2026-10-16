// The renamed tool uses the release's renderer API, while old transcript calls keep their presentation.
import assert from "node:assert/strict";
import { test } from "node:test";

type Args = Record<string, unknown>;
type Summary = { verb: string; noun?: string; by?: string };
type Renderer = {
    tool: string;
    label(args: Args): string;
    subject(args: Args): string;
    summary(args: Args): Summary;
};

const calls = await import(new URL("../web/calls.js", import.meta.url).href);
const turns = await import(new URL("../web/turns.js", import.meta.url).href);
const module = await import(
    new URL("../src/server/extensions/agent-teams.js", import.meta.url).href
);

test("team start, send and list render through the extension with the existing chat argument", () => {
    let renderer: Renderer | undefined;

    module.default({
        toolCall: (value: Renderer) => {
            renderer = value;
        },
    });
    assert.equal(renderer?.tool, "team");
    const own = renderer!;

    calls.setCallDescriber((tool: string, args: Args) =>
        tool === own.tool ? { label: own.label(args), subject: own.subject(args) } : undefined,
    );
    turns.setCallSummary((tool: string, args: Args) =>
        tool === own.tool ? own.summary(args) : undefined,
    );

    try {
        assert.deepEqual(
            calls.describeCall({
                name: "team",
                args: { action: "start", title: "Review", message: "Check it" },
            }),
            {
                icon: "⚙",
                mono: false,
                own: true,
                label: "start session",
                subject: "Review · Check it",
            },
        );
        const send = (id: string, chat: string) => ({
            block: {
                type: "toolCall",
                id,
                name: "team",
                args: { action: "send", chat, message: "Result" },
            },
        });

        assert.equal(
            turns.summarize([send("a", "chat-first"), send("b", "chat-first")]),
            "Messaged a session",
        );
        assert.equal(
            turns.summarize([send("a", "chat-first"), send("b", "chat-second")]),
            "Messaged 2 sessions",
        );
        assert.equal(
            turns.summarize([
                { block: { type: "toolCall", id: "c", name: "team", args: { action: "list" } } },
            ]),
            "Checked linked sessions",
        );
        assert.equal(
            calls.describeCall({ name: "agent_chat", args: { action: "send", chat: "chat-old" } })
                .label,
            "Linked chat send",
        );
        assert.equal(
            turns.summarize([
                {
                    block: {
                        type: "toolCall",
                        id: "old",
                        name: "agent_chat",
                        args: { action: "start" },
                    },
                },
            ]),
            "Started a chat",
        );
    } finally {
        calls.setCallDescriber(() => undefined);
        turns.setCallSummary(() => undefined);
    }
});
