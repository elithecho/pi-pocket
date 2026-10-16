// Message-box editing shortcuts in the real app, against a throwaway server.
import {
    type App,
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { InboxDoc, type ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser" : false };
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let session: ConversationId;

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(
        scriptedModel((request) => {
            const { role, text } = lastText(request as never);

            if (role === "user" && text.includes("hold queue controls")) {
                return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], {
                    stopReason: "toolUse",
                });
            }

            return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
        }),
    );
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    session = await newSession(app);

    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "composer-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            (await page.evaluate(
                `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
            )) === "true",
        "signed in",
    );
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            (await page.evaluate(
                `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
            )) === "true",
        "message box",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function edit(value: string, start: number, end = start, modifiers = {}) {
    await page.evaluate(`
        const box = document.querySelector(".composer textarea");
        box.focus();
        box.value = ${JSON.stringify(value)};
        box.dispatchEvent(new Event("input", { bubbles: true }));
    `);

    // Let Preact commit the input before sending the key.
    return JSON.parse(
        await page.evaluate(`
        const box = document.querySelector(".composer textarea");
        box.setSelectionRange(${start}, ${end});
        const event = new KeyboardEvent("keydown", {
            key: "w", ctrlKey: true, bubbles: true, cancelable: true,
            ...${JSON.stringify(modifiers)},
        });
        box.dispatchEvent(event);
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);

        return JSON.stringify({
            value: box.value, start: box.selectionStart, end: box.selectionEnd,
            prevented: event.defaultPrevented,
        });
    `),
    );
}

test(
    "Ctrl+W deletes the previous word or selection and keeps the caret at the cut",
    real,
    async () => {
        for (const [value, start, end, expected, caret] of [
            ["hello world", 11, 11, "hello ", 6],
            ["hello world   ", 14, 14, "hello ", 6],
            ["hello world again", 9, 9, "hello ld again", 6],
            ["hello world again", 6, 11, "hello  again", 6],
            ["hello\nworld\n  ", 14, 14, "hello\n", 6],
            ["你好 世界", 5, 5, "你好 ", 3],
            ["   ", 3, 3, "", 0],
            ["hello", 0, 0, "hello", 0],
            ["", 0, 0, "", 0],
        ] as const) {
            assert.deepEqual(await edit(value, start, end), {
                value: expected,
                start: caret,
                end: caret,
                prevented: true,
            });
        }

        await edit("hello world", 11);
        await page.navigate(page.url);
        await until(
            async () =>
                (await page.evaluate(
                    `return JSON.stringify(document.querySelector(".composer textarea")?.value === "hello ")`,
                )) === "true",
            "edited draft survives reload",
        );
    },
);

test("Ctrl+W ignores composition and additional modifiers", real, async () => {
    for (const modifiers of [
        { isComposing: true },
        { metaKey: true },
        { altKey: true },
        { shiftKey: true },
        { ctrlKey: false, metaKey: true },
    ]) {
        assert.deepEqual(await edit("hello world", 11, 11, modifiers), {
            value: "hello world",
            start: 11,
            end: 11,
            prevented: false,
        });
    }
});

test(
    "queue arrows promote one message; Mod+Enter promotes all without sending the draft",
    real,
    async () => {
        await app.commands.submit(session, owner(app), {
            text: "hold queue controls",
            requestId: "hold-controls",
        });
        await until(
            async () => (await modelTexts(app, session)).some((text) => text.includes("sleep 30")),
            "tool round holding the queue",
        );
        const queue = async (text: string) =>
            app.commands.submit(session, owner(app), {
                text,
                requestId: crypto.randomUUID(),
                mode: "followUp",
            });
        const modes = async () =>
            (await app.harness.snapshot(InboxDoc, session, context))!.items.map(
                (item) => item.mode,
            );
        const arrows = async () =>
            JSON.parse(
                await page.evaluate(
                    `return JSON.stringify(document.querySelectorAll('[aria-label="Steer now"]').length)`,
                ),
            );
        const apple =
            (await page.evaluate(`return JSON.stringify((await import('/ui.js')).APPLE)`)) ===
            "true";
        const mod = apple
            ? { key: "Enter", ctrlKey: false, metaKey: true }
            : { key: "Enter", ctrlKey: true };

        try {
            await queue("first queued");
            await queue("second queued");
            await until(async () => (await arrows()) === 2, "two promotion arrows");
            await page.click({
                selector: '[role="radio"][title="Pi reads it when this run ends"]',
            });
            await page.click({ selector: '[aria-label="Steer now"]' });
            await until(
                async () => (await modes()).join() === "steer,followUp",
                "only first promoted",
            );
            await until(async () => (await arrows()) === 1, "promoted arrow removed");

            // IME Enter does not promote or send. Mod+Enter leaves a command-like draft and the Queue toggle alone.
            assert.equal(
                (await edit("/draft stays", 12, 12, { ...mod, isComposing: true })).prevented,
                false,
            );
            assert.deepEqual(await modes(), ["steer", "followUp"]);
            assert.equal((await edit("/draft stays", 12, 12, mod)).prevented, true);
            await until(
                async () => (await modes()).join() === "steer,steer",
                "all pending messages promoted",
            );
            assert.equal(
                await page.evaluate(
                    `return JSON.stringify(document.querySelector('.composer textarea').value)`,
                ),
                JSON.stringify("/draft stays"),
            );
            assert.equal(
                await page.evaluate(
                    `return JSON.stringify([...document.querySelectorAll('[role="radio"]')].find((button) => button.textContent.trim() === "Queue").getAttribute('aria-checked'))`,
                ),
                JSON.stringify("true"),
            );

            // Empty draft works too, with multiple follow-ups. No queue is also a handled no-op.
            await queue("third queued");
            await queue("fourth queued");
            assert.equal((await edit("", 0, 0, mod)).prevented, true);
            await until(
                async () => (await modes()).join() === "steer,steer,steer,steer",
                "empty draft promotes every follow-up",
            );
            assert.equal((await edit("unsent words", 12, 12, mod)).prevented, true);
            assert.equal((await modes()).length, 4);

            // Ordinary Enter still submits the draft using the selected Queue mode.
            await edit("ordinary enter", 14, 14, { key: "Enter", ctrlKey: false });
            await until(
                async () => (await modes()).join() === "steer,steer,steer,steer,followUp",
                "normal Enter still queues",
            );
        } finally {
            await app.commands.abort(session, owner(app));
        }
    },
);
