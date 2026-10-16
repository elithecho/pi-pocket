import { cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

test(
    "model picker starts scoped and Tab toggles inline scope without changing the model",
    {
        skip: findBrowser() === undefined ? "no Chromium-based browser" : false,
    },
    async () => {
        const app = await openApp(scriptedModel());

        app.settings.setEnabledModels(["faux/faux-2"]);
        const session = await newSession(app);
        const original = (await app.agentState(session))?.model;
        const server = createServer(
            createHandler({
                app,
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            }),
        );
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "model-scope-ui-")),
            load: async () => undefined,
            save: () => {},
        });

        try {
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
            const page = await browsers.open(1);

            await page.setViewport({ width: 1280, height: 800, scale: 1, mobile: false });
            const see = (expression: string) =>
                until(
                    async () =>
                        (await page.evaluate(`return JSON.stringify(${expression})`)) === "true",
                    expression,
                );

            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await see(`(await import('/store.js')).store.state.me?.role === 'owner'`);
            await page.evaluate(`(await import('/store.js')).navigate(${session}); return 'true'`);
            await see(
                `(await import('/store.js')).store.state.view.conversation?.id === ${session}`,
            );
            await page.evaluate(
                `(await import('/store.js')).openSheet({type: 'model'}); return 'true'`,
            );
            await see(`document.querySelectorAll('.model-menu [role="option"]').length === 1`);
            await see(
                `document.querySelector('.pop-menu-head .model-scope button.on')?.textContent === 'scoped'`,
            );
            await see(`document.activeElement.matches('.model-menu')`);
            await see(
                `document.querySelector('.model-scope button').getBoundingClientRect().height < 40`,
            );
            await page.press("Tab");
            await see(`document.querySelectorAll('.model-menu [role="option"]').length === 3`);
            await see(`document.querySelector('.model-scope button.on')?.textContent === 'all'`);
            await see(`document.activeElement === document.querySelector('.model-scope button')`);
            await page.press("Tab");
            await see(
                `document.activeElement === document.querySelector('.model-scope button:nth-of-type(2)')`,
            );
            await see(`document.querySelector('.model-scope button.on')?.textContent === 'all'`);
            await page.press("Tab");
            await see(`document.activeElement.matches('.model-menu .pop-menu-link')`);
            await see(`document.querySelector('.model-scope button.on')?.textContent === 'all'`);
            await page.press("Tab");
            await see(`document.activeElement.matches('.model-menu [role="option"]')`);
            await page.evaluate(
                `document.querySelector('.model-scope button').click(); return 'true'`,
            );
            await see(`document.querySelectorAll('.model-menu [role="option"]').length === 1`);
            await page.evaluate(
                `const s = await import('/store.js'); s.closeSheet(); return 'true'`,
            );
            await see(`!document.querySelector('.model-menu')`);
            await page.evaluate(
                `(await import('/store.js')).openSheet({type: 'model', query: 'no-such-model'}); return 'true'`,
            );
            await see(`!!document.querySelector('.model-menu input')`);
            await see(`document.activeElement.matches('.model-menu input')`);
            await page.press("Shift+Tab");
            await see(`document.activeElement.matches('.model-menu .pop-menu-link')`);
            await see(`document.querySelector('.model-scope button.on')?.textContent === 'scoped'`);
            await page.press("Tab");
            await see(`document.activeElement.matches('.model-menu input')`);
            await see(`document.querySelector('.model-scope button.on')?.textContent === 'scoped'`);
            await page.press("Tab");
            await see(`document.querySelector('.model-scope button.on')?.textContent === 'all'`);
            await see(`document.querySelector('.model-menu input').value === 'no-such-model'`);

            await page.setViewport({ width: 390, height: 844, scale: 2, mobile: true });
            await see(`matchMedia('(pointer: coarse)').matches`);
            await see(
                `[...document.querySelectorAll('.model-scope button')].every((button) => { const { width, height } = button.getBoundingClientRect(); return width >= 40 && height >= 40; })`,
            );
            assert.deepEqual((await app.agentState(session))?.model, original);
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            server.close();
            await app.close();
            cleanUp();
        }
    },
);
