/** Actual local pi-goal through Pocket's browser/composer. Explicit opt-in package path, scripted provider only. */
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
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { TerminalStateDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";

const path = process.env.PI_POCKET_GOAL_EXTENSION;

if (!path) {
    throw new Error(
        "Set PI_POCKET_GOAL_EXTENSION to the installed/local pi-goal entry. No installation is performed.",
    );
}

writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR!, "settings.json"),
    JSON.stringify({ extensions: [resolve(path)] }),
);
after(cleanUp);

test("actual pi-goal works in desktop/mobile composer: start, busy pause, replacement dialog, reconnect, resume, continuation, completion and budget", async () => {
    assert.notEqual(
        findBrowser(),
        undefined,
        "actual browser acceptance requires Chromium; do not skip it",
    );

    let release = () => {};

    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let calls = 0;
    const provider = scriptedModel(async (_request, options) => {
        calls++;

        if (calls === 1) {
            await new Promise<void>((resolve) => {
                options?.signal?.addEventListener("abort", () => resolve(), { once: true });
                void gate.then(resolve);
            });
        }

        if (calls === 3) {
            return fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], {
                stopReason: "toolUse",
            });
        }

        return fauxAssistantMessage([
            fauxText(
                "A substantive scripted response with enough tokens to exhaust the explicit tiny budget",
            ),
        ]);
    });
    const app = await openApp(provider);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    const browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "actual-goal-browser-")),
        load: async () => undefined,
        save: () => {},
    });

    try {
        await app.setExtensionEnabled(owner(app), "terminal.ts", true);
        const id = await newSession(app);

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const page = await browsers.open(1);
        const evaluate = async <T>(script: string): Promise<T> =>
            JSON.parse(await page.evaluate(script)) as T;
        const see = (script: string, label: string) =>
            until(() => evaluate<boolean>(`return JSON.stringify(${script})`), label);

        const send = async (text: string) => {
            await page.type({ selector: ".composer textarea" }, text);
            await see(
                `(await import('/commands.js')).parseCommand(${JSON.stringify(text)})?.command.extension === true`,
                "actual plugin command resolved",
            );
            await page.click({ label: "Send" });
        };

        const goal = async (conversation: ConversationId = id) => {
            const stored = await app.harness.snapshot(TerminalStateDoc, conversation, context);
            const entry = stored?.entries
                .map(({ sdk }) => sdk)
                .findLast(
                    (sdk) =>
                        sdk &&
                        typeof sdk === "object" &&
                        !Array.isArray(sdk) &&
                        sdk.type === "custom" &&
                        sdk.customType === "pi-goal",
                );

            assert.ok(entry && typeof entry === "object" && !Array.isArray(entry));
            const data = entry.data;

            assert.ok(data && typeof data === "object" && !Array.isArray(data));
            const value = data.goal;

            assert.ok(value && typeof value === "object" && !Array.isArray(value));

            return value;
        };

        await page.setViewport(VIEWPORTS.desktop);
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await page.navigate(`${base}/s/${id}`);
        await see(`document.querySelector('.composer textarea') !== null`, "desktop composer");
        await page.type({ selector: ".composer textarea" }, "/goal");
        await see(
            `[...document.querySelectorAll('[role=option]')].some(e => e.textContent.includes('/goal') && e.textContent.includes('Pi extension'))`,
            "actual goal suggestion",
        );
        await send("/goal exercise actual browser goal");
        await until(() => calls === 1 && app.isBusy(id), "goal starts the native model request");
        assert.equal((await goal()).status, "active");
        await page.setViewport(VIEWPORTS.mobile);
        await send("/goal pause");
        await until(
            async () => (await goal()).status === "paused",
            "goal paused while provider is busy",
        );
        release();
        await until(() => !app.isBusy(id), "paused request finishes without continuation");
        assert.equal(calls, 1);
        await send("/goal replacement UI objective");
        await see(
            `document.querySelector('.terminal-dialog')?.textContent.includes('Replace goal?') === true`,
            "actual replacement confirmation",
        );
        await page.click({ selector: ".terminal-dialog button[type=button]" });
        await see(
            `document.querySelector('.terminal-dialog') === null && document.querySelector('.composer textarea').value === ''`,
            "replacement cancelled",
        );
        assert.equal((await goal()).objective, "exercise actual browser goal");
        await page.reload();
        await see(`document.querySelector('.terminal-status') !== null`, "restored goal status");
        assert.equal((await goal()).status, "paused");
        assert.equal(
            await evaluate<boolean>(
                `return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)`,
            ),
            true,
        );
        await send("/goal resume");
        await until(
            async () => !app.isBusy(id) && (await goal()).status === "complete",
            "actual tool completion after continuation",
            20000,
        );
        assert.equal(calls, 4);
        const messages = (await (await app.conversation(id)).context(context)).messages;

        assert.match(JSON.stringify(messages), /Continue working toward the active thread goal/);
        assert.equal(
            messages.some(
                (message) =>
                    message.role === "toolResult" &&
                    message.toolName === "update_goal" &&
                    !message.isError,
            ),
            true,
        );
        const other = await newSession(app);

        await page.navigate(`${base}/s/${other}`);
        await see(`document.querySelector('.composer textarea') !== null`, "budget goal composer");
        await send("/goal --tokens 1 exercise actual browser budget");
        await until(
            async () => !app.isBusy(other) && (await goal(other)).status === "budget_limited",
            "actual browser budget limit",
            20000,
        );
        assert.equal(calls, 6, "budget goal receives only pursuing and wrap-up turns");
        assert.equal((await goal(other)).tokenBudget, 1);
        assert.deepEqual(
            page.logs().filter((line) => line.level === "error"),
            [],
        );
    } finally {
        release();
        await browsers.closeAll({ final: true });
        server.closeAllConnections();
        server.close();
        await app.close();
    }
});
