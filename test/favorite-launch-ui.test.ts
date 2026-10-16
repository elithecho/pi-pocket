// Favorites-first session creation and direct command palette launches in a real phone-sized browser.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

/** Run a script in a page and read back the JSON it returns. */
async function inPage<T>(script: string, on = page): Promise<T> {
    return JSON.parse(await on.evaluate(script)) as T;
}

/** Wait until a script in the page returns true. */
const see = (script: string, what: string, on = page) =>
    until(async () => (await inPage<boolean>(script, on)) === true, what);

/** Wait until the page shows `text`. */
const shows = (text: string, on = page) =>
    see(
        `return JSON.stringify(document.body.innerText.includes(${JSON.stringify(text)}))`,
        text,
        on,
    );

/**
 * Past a sheet's rise, as a person's next tap is: a tap right after something slid in under the finger is let go
 * (`back.js`), and its rows are still moving.
 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 450));

/** The New session sheet, at phone size, on the session list. */
async function newSessionSheet(on = page, browse = true): Promise<void> {
    await on.setViewport(VIEWPORTS.mobile);
    await on.navigate(`${base}/`);
    await see(
        `return JSON.stringify(document.querySelector(".composer, .home-list, .splash") !== null)`,
        "the app",
        on,
    );
    await on.evaluate(`(await import("/store.js")).openSheet({ type: "cwd", mode: "new" })`);
    await shows("New session", on);
    await settled();

    if (
        browse &&
        (await inPage<boolean>(
            `return JSON.stringify(!!document.querySelector('.favorite-launch-list'))`,
            on,
        ))
    ) {
        await on.click({ label: "Choose another folder" });
        await see(
            `return JSON.stringify(!!document.querySelector('.fp-list'))`,
            "folder listing",
            on,
        );
        await settled();
    }

    if (await inPage<boolean>(`return JSON.stringify(!!document.querySelector('.fp-list'))`, on)) {
        await see(
            `return JSON.stringify(document.querySelector('.fp-crumb.here')?.textContent.trim() === '~')`,
            "new-session browsing starts at home, not the server's default working folder",
            on,
        );
        // The remaining favorite/session checks use the isolated test working folder.
        await on.click({ selector: ".fp-crumb.here" });
        await on.type({ label: "Go to a path" }, work, { submit: true });
        await see(
            `return JSON.stringify(document.querySelector('.fp-crumbs')?.textContent.includes(${JSON.stringify(work.split("/").pop())}))`,
            "test working folder",
            on,
        );
    }
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "pi-sessions-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "New session waits for favorites, launches on click, and keeps browsing explicit",
    real,
    async () => {
        await newSession(app);
        await newSessionSheet(page, false);
        await see(
            `return JSON.stringify(!!document.querySelector('.fp-list'))`,
            "empty favorites use browser",
        );
        await page.click({ label: "Add to favorites" });
        await see(
            `return JSON.stringify((await import('/store.js')).store.state.folderFavorites.length === 1)`,
            "favorite saved",
        );
        await newSessionSheet(page, false);
        await see(
            `return JSON.stringify(!!document.querySelector('.favorite-launch-list') && !document.querySelector('.fp-list'))`,
            "favorites first",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.activeElement?.classList.contains('favorite-launch'))`,
            ),
            true,
            "first favorite focused",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)`,
            ),
            true,
            "chooser fits phone",
        );

        // Opening before hello must wait, not mistake the initial [] for an empty saved list.
        await page.evaluate(`
        const { store, openSheet, closeSheet } = await import('/store.js');
        closeSheet();
        store.set({ folderFavorites: [], folderFavoritesReady: false });
        openSheet({ type: 'cwd', mode: 'new' });
    `);
        await shows("Loading favorites");
        await page.evaluate(
            `(await import('/store.js')).store.set({ folderFavorites: [${JSON.stringify(work)}], folderFavoritesReady: true })`,
        );
        await see(
            `return JSON.stringify(!!document.querySelector('.favorite-launch-list') && !document.querySelector('.fp-list'))`,
            "late favorites show chooser",
        );
        await settled();
        await page.click({ label: "Choose another folder" });
        await see(
            `return JSON.stringify(!!document.querySelector('.fp-list'))`,
            "explicit browsing",
        );
        await see(
            `return JSON.stringify(document.querySelector('.fp-crumb.here')?.textContent.trim() === '~')`,
            "Choose another folder starts at home",
        );
        await page.evaluate(
            `(await import('/store.js')).store.set({ folderFavorites: [${JSON.stringify(work)}, '/another-favorite'] })`,
        );
        await see(
            `return JSON.stringify(!!document.querySelector('.fp-list') && !document.querySelector('.favorite-launch-list'))`,
            "live favorites do not interrupt browsing",
        );
        await page.evaluate(
            `(await import('/store.js')).store.set({ folderFavorites: [${JSON.stringify(work)}] })`,
        );
        await newSessionSheet(page, false);
        await page.click({ label: "Own git worktree" });
        await page.evaluate(`
        const { actions } = await import('/store.js');
        const original = actions.createSession;
        window.favoriteCalls = [];
        actions.createSession = async (path, options) => {
            window.favoriteCalls.push({ path, options });
            await new Promise(resolve => setTimeout(resolve, 100));
            throw new Error('Favorite launch failed');
        };
        window.restoreFavoriteLaunch = () => { actions.createSession = original; };
        const button = document.querySelector('.favorite-launch');
        button.click();
        button.click();
    `);
        await shows("Favorite launch failed");
        assert.deepEqual(await inPage(`return JSON.stringify(window.favoriteCalls)`), [
            { path: work, options: { worktree: true } },
        ]);
        await page.evaluate(`window.restoreFavoriteLaunch()`);
        await page.click({ label: "Own git worktree" });
        await page.click({ selector: ".favorite-launch" });
        await see(
            `return JSON.stringify(!(await import('/store.js')).store.state.sheet && (await import('/store.js')).store.state.view.agent?.cwd === ${JSON.stringify(work)})`,
            "one click opens real session",
        );
        await newSessionSheet(page, false);
        await page.evaluate(
            `(await import('/store.js')).api('folder-favorites', { path: ${JSON.stringify(work)}, starred: false })`,
        );
        await see(
            `return JSON.stringify(!!document.querySelector('.fp-list'))`,
            "last favorite removal returns to browser",
        );
    },
);

test("command palette offers each favorite as a direct New Session action", real, async () => {
    await newSessionSheet();
    await page.click({ label: "Add to favorites" });
    await see(
        `return JSON.stringify((await import('/store.js')).store.state.folderFavorites.length === 1)`,
        "favorite saved",
    );
    const name = work.split("/").pop();
    const label = `New Session: ${name}`;

    await page.evaluate(`
        const { store, closeSheet } = await import('/store.js');
        closeSheet();
        store.set({ launcher: true });
    `);
    await see(`return JSON.stringify(!!document.querySelector('.launcher input'))`, "palette open");
    await page.evaluate(`
        const input = document.querySelector('.launcher input');
        input.value = ${JSON.stringify(`> ${label}`)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await shows(label);
    await settled();
    await page.click({ label });
    await see(
        `
        const { store } = await import('/store.js');
        return JSON.stringify(!store.state.launcher && !store.state.sheet && store.state.view.agent?.cwd === ${JSON.stringify(work)});
    `,
        "palette launches favorite without folder picker",
    );
    await page.evaluate(
        `(await import('/store.js')).api('folder-favorites', { path: ${JSON.stringify(work)}, starred: false })`,
    );
    await see(
        `return JSON.stringify((await import('/store.js')).store.state.folderFavorites.length === 0)`,
        "favorite removed",
    );
    await page.evaluate(`(await import('/store.js')).store.set({ launcher: true })`);
    await see(
        `return JSON.stringify(!!document.querySelector('.launcher input'))`,
        "palette reopened",
    );
    await page.evaluate(`
        const input = document.querySelector('.launcher input');
        input.value = ${JSON.stringify(`> ${label}`)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await see(
        `return JSON.stringify(!document.querySelector('#launcher-results')?.textContent.includes(${JSON.stringify(label)}))`,
        "removed favorite disappears",
    );
    await page.evaluate(`(await import('/store.js')).store.set({ launcher: false })`);
});
