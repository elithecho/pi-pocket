/** Large histories cross real fork IPC without losing branch or canonical context content. */
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TerminalStateDoc, TerminalWorkDoc } from "../src/server/docs.ts";
import { RequestBudget } from "../src/server/terminal/request-budget.ts";
import { terminalSnapshot } from "../src/server/terminal/projection.ts";
import { MAX_PACKET_BYTES } from "../src/server/terminal/protocol.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR!;
const plugin = join(agentDir, "large-history.ts");

writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [plugin] }));
writeFileSync(
    plugin,
    `import { createHash } from "node:crypto";
    function inspect(ctx) {
        const hash = values => createHash("sha256").update(JSON.stringify(values)).digest("hex");
        const branch = ctx.sessionManager.getBranch().filter(e => e.type === "message").map(e => e.message);
        const canonical = ctx.sessionManager.buildSessionProjection().messages;
        return { branch: hash(branch), canonical: hash(canonical), count: branch.length };
    }
    export default function (pi) {
        pi.on("session_start", async (_, ctx) => pi.appendEntry("large-start", inspect(ctx)));
        pi.registerCommand("goal", { handler: async (args, ctx) => {
            if (args === "hold") await ctx.ui.confirm("Hold", "Waiting for shutdown");
            pi.appendEntry("large-command", inspect(ctx));
        }});
    }`,
);

test("large /goal snapshots preserve every message during initialization, refresh, retry and restart", async (t) => {
    const budgets = new Set<RequestBudget>();
    const reserve = RequestBudget.prototype.reserve;

    t.mock.method(RequestBudget.prototype, "reserve", function (this: RequestBudget) {
        budgets.add(this);

        return reserve.call(this);
    });
    const provider = scriptedModel();
    const dataDir = join(root, "large-history");
    let app = await openApp(provider, dataDir);

    try {
        const id = await newSession(app);
        const messages = [
            { role: "user" as const, content: "first:" + "a".repeat(900_000), timestamp: 1 },
            { role: "user" as const, content: "middle:" + '🙂\n\\"'.repeat(200_000), timestamp: 2 },
            { role: "user" as const, content: "last:" + "z".repeat(900_000), timestamp: 3 },
        ];

        const append = async (message: (typeof messages)[number]) => {
            await app.harness.commit(
                (tx) => tx.appendEntry(id, { kind: "test.large-history", model: [message] }),
                context,
            );
        };

        const expected = () => {
            const hash = createHash("sha256").update(JSON.stringify(messages)).digest("hex");

            return { branch: hash, canonical: hash, count: messages.length };
        };

        const observed = async (customType: string) => {
            const state = await app.harness.snapshot(TerminalStateDoc, id, context);

            return (state?.entries ?? []).flatMap(({ sdk }) =>
                sdk &&
                typeof sdk === "object" &&
                !Array.isArray(sdk) &&
                sdk.customType === customType
                    ? [sdk.data]
                    : [],
            );
        };

        const send = (requestId: string) =>
            app.commands.submit(id, owner(app), { text: "/goal", requestId });

        for (const message of messages) {
            await append(message);
        }

        await app.setExtensionEnabled(owner(app), "terminal.ts", true);
        await send("large-first");
        assert.deepEqual(await observed("large-start"), [expected()]);
        assert.deepEqual(await observed("large-command"), [expected()]);
        assert.ok(
            Buffer.byteLength(JSON.stringify(await terminalSnapshot(app, id))) > MAX_PACKET_BYTES,
        );
        await send("large-first");
        assert.equal(
            (await observed("large-command")).length,
            1,
            "retry must not rerun the handler",
        );

        const budget = [...budgets][0]!;
        const held = Array.from({ length: 4 }, () => reserve.call(budget));
        const before = await app.harness.snapshot(TerminalWorkDoc, id, context);
        const conversationCalls = t.mock.method(app, "conversation");

        try {
            await assert.rejects(
                app.terminal.command(id, owner(app), "goal", "", "budget-retry"),
                /memory is busy/,
            );
            assert.equal(
                conversationCalls.mock.callCount(),
                0,
                "reject before constructing a snapshot",
            );
            assert.deepEqual(
                await app.harness.snapshot(TerminalWorkDoc, id, context),
                before,
                "reject before creating an uncertain operation marker",
            );
            assert.equal(
                app.terminal.problem(id, owner(app)),
                null,
                "do not invalidate a healthy host",
            );
        } finally {
            conversationCalls.mock.restore();
            held.forEach((lease) => lease.release());
        }

        await app.terminal.command(id, owner(app), "goal", "", "budget-retry");
        assert.equal((await observed("large-command")).length, 2);
        const update = {
            role: "user" as const,
            content: "new context after startup",
            timestamp: 4,
        };

        messages.push(update);
        await append(update);
        await send("large-refresh");
        assert.deepEqual((await observed("large-command")).at(-1), expected());
        await app.close();
        app = await openApp(provider, dataDir);
        await send("large-restarted");
        assert.deepEqual((await observed("large-start")).at(-1), expected());
        assert.deepEqual((await observed("large-command")).at(-1), expected());
        assert.equal(app.terminal.problem(id, owner(app)), null);
        assert.equal(provider.state.callCount, 0);
        const interrupted = app.terminal.command(
            id,
            owner(app),
            "goal",
            "hold",
            "close-held-request",
        );
        const stopped = assert.rejects(interrupted, /disposed|exited|interrupted/);

        await until(() => app.terminal.dialogs(id, owner(app)).length > 0, "large command waiting");
        await app.close();
        await stopped;
    } finally {
        await app.close();

        for (const budget of budgets) {
            const restored = Array.from({ length: 4 }, () => reserve.call(budget));

            restored.forEach((lease) => lease.release());
        }

        cleanUp();
    }
});
