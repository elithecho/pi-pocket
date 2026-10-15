// Favorite folders belong to a signed-in person and survive a restart in SQLite, not in a browser's storage.
import { type App, cleanUp, fakeTab, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let base = "";
const dataDir = join(root, "favorites-data");

async function start() {
    app = await openApp(scriptedModel(), dataDir);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
}

async function stop() {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app?.close();
}

const request = (token = app.config.ownerToken, body?: unknown, pocket = true) =>
    fetch(`${base}/folder-favorites`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, ...(pocket ? { "x-pocket": "1" } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

async function favorites(token = app.config.ownerToken): Promise<string[]> {
    const response = await request(token);

    assert.equal(response.status, 200);

    return (await response.json()) as string[];
}

async function set(path: string, starred = true, token = app.config.ownerToken) {
    const response = await request(token, { path, starred });

    assert.equal(response.status, 200, await response.text());
}

before(start);
after(async () => {
    await stop();
    cleanUp();
});

test("favorites start empty, are ordered, and explicit star/unstar requests are idempotent", async () => {
    assert.deepEqual(await favorites(), []);
    const first = join(root, "first");
    const second = join(root, "second");

    await set(first);
    await set(second);
    await set(first);
    assert.deepEqual(await favorites(), [first, second]);
    await set(first, false);
    await set(first, false);
    assert.deepEqual(await favorites(), [second]);
    await set(first);
    assert.deepEqual(await favorites(), [second, first]);
});

test("only the signed-in person's favorites are read, changed, or broadcast", async () => {
    const guest = app.config.addUser("Guest", "guest");
    const ownerTab = fakeTab(undefined, owner(app));
    const otherOwnerTab = fakeTab(undefined, owner(app));
    const guestTab = fakeTab(undefined, guest.user);

    await app.attach(ownerTab.client);
    await app.attach(otherOwnerTab.client);
    await app.attach(guestTab.client);

    try {
        const theirs = join(root, "guest-folder");
        const ours = await favorites();

        assert.deepEqual(await favorites(guest.token), []);
        const spoofed = await request(guest.token, {
            path: theirs,
            starred: true,
            userId: owner(app).id,
        });

        assert.equal(spoofed.status, 200);
        assert.deepEqual(await favorites(guest.token), [theirs]);
        assert.deepEqual(await favorites(), ours);
        assert.deepEqual(guestTab.last("folder-favorites"), [theirs]);
        assert.ok(
            !JSON.stringify(ownerTab.events).includes(theirs),
            "no guest paths leak to the owner",
        );
        const added = join(root, "owner-folder");

        await set(added);
        assert.deepEqual(ownerTab.last("folder-favorites"), [...ours, added]);
        assert.deepEqual(otherOwnerTab.last("folder-favorites"), [...ours, added]);
        assert.ok(
            !JSON.stringify(guestTab.events).includes(added),
            "no owner paths leak to a guest",
        );
        assert.deepEqual(ownerTab.last("hello")?.folderFavorites, ours);
        assert.deepEqual(guestTab.last("hello")?.folderFavorites, []);
    } finally {
        app.detach(ownerTab.client);
        app.detach(otherOwnerTab.client);
        app.detach(guestTab.client);
    }
});

test("concurrent changes keep other folders and other users' updates", async () => {
    const guest = app.config.addUser("Concurrent guest", "guest");
    const before = await favorites();
    const paths = Array.from({ length: 12 }, (_, i) => join(root, `concurrent-${i}`));

    await Promise.all(paths.flatMap((path) => [set(path), set(path, true, guest.token)]));
    assert.deepEqual(new Set(await favorites()), new Set([...before, ...paths]));
    assert.deepEqual(new Set(await favorites(guest.token)), new Set(paths));
    await Promise.all(paths.map((path) => set(path, false)));
    assert.deepEqual(await favorites(), before);
    assert.deepEqual(new Set(await favorites(guest.token)), new Set(paths));
});

test("routes require authentication, the X-Pocket header, valid paths, and permission to create sessions", async () => {
    assert.equal((await request("not-a-token")).status, 401);
    assert.equal((await request(undefined, { path: root, starred: true }, false)).status, 403);

    for (const body of [
        {},
        { path: "relative", starred: true },
        { path: root },
        { path: root, starred: "true" },
        { path: 4, starred: true },
        { path: root + "\u0000", starred: true },
        { path: "/" + "a".repeat(4096), starred: true },
    ]) {
        assert.equal((await request(undefined, body)).status, 400);
    }

    const viewer = app.config.addUser("Viewer", "viewer");
    const scoped = app.config.addUser("Scoped", "guest", ["123"]);

    assert.equal((await request(viewer.token, { path: root, starred: true })).status, 403);
    assert.equal((await request(scoped.token, { path: root, starred: true })).status, 403);
});

test("a slow initial hello does not replace a favorite committed while the device connects", async () => {
    const tab = fakeTab(undefined, owner(app));
    const original = app.guardStatus;
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
        release = resolve;
    });
    const started = new Promise<void>((resolve) => {
        reached = resolve;
    });

    app.guardStatus = async () => {
        reached();
        await waiting;

        return original.call(app);
    };

    const attaching = app.attach(tab.client);

    try {
        await started;
        await set(join(root, "saved-while-connecting"));
        release();
        await attaching;
        assert.deepEqual(tab.last("hello")?.folderFavorites, await favorites());
    } finally {
        release();
        app.guardStatus = original;
        await attaching;
        app.detach(tab.client);
    }
});

test("favorite lists are bounded, and removal and retries still work at the limit", async () => {
    const person = app.config.addUser("Many favorites", "guest");
    const paths = Array.from({ length: 100 }, (_, i) => join(root, `favorite-${i}`));

    await Promise.all(paths.map((path) => set(path, true, person.token)));
    assert.equal((await favorites(person.token)).length, 100);
    assert.equal(
        (await request(person.token, { path: join(root, "one-too-many"), starred: true })).status,
        409,
    );
    assert.equal(
        (await favorites(person.token)).length,
        100,
        "a refused commit leaves the list unchanged",
    );
    await set(paths[0]!, true, person.token);
    await set(paths[0]!, false, person.token);
    await set(join(root, "one-too-many"), true, person.token);
    assert.equal((await favorites(person.token)).length, 100);
});

test("favorites and shortcut order survive a server restart and appear in hello", async () => {
    const saved = await favorites();

    await stop();
    await start();
    assert.deepEqual(await favorites(), saved);
    const response = await fetch(`${base}/me`, {
        headers: { authorization: `Bearer ${app.config.ownerToken}` },
    });
    const hello = (await response.json()) as { folderFavorites: string[] };

    assert.deepEqual(hello.folderFavorites, saved);
});
