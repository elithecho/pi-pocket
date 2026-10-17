// Rerunnable preservation audit for the experimental upstream reconciliation; no writes or live data access.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const local = "8874dab";
const upstream = "e5456a832d47e7154faf04320dd7602ae5051bf7";
const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const files = (ref) => new Set(git("ls-tree", "-r", "--name-only", ref).split("\n"));
const ours = files(local);
const theirs = files(upstream);
const forkOnly = [...ours].filter((path) => !theirs.has(path));
const upstreamOnly = [...theirs].filter((path) => !ours.has(path));
const changedForkOnly = [];

for (const path of forkOnly) {
    assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `Lost fork-only file: ${path}`);

    if (git("hash-object", "--", path) !== git("rev-parse", `${local}:${path}`)) {
        changedForkOnly.push(path);
    }
}

assert.deepEqual(changedForkOnly, [
    "test/favorite-launch-ui.test.ts",
    "test/linked-chats.test.ts",
    "test/pi-sessions-ui.test.ts",
]);

for (const path of upstreamOnly) {
    // Deliberately retain the fork's deletion of the obsolete upstream Teams service and its incompatible test.
    if (
        [
            "src/server/linked-sessions.ts",
            "test/linked-sessions.test.ts",
            "web/linked-sessions.js",
        ].includes(path)
    ) {
        continue;
    }

    assert.ok(
        existsSync(new URL(`../${path}`, import.meta.url)),
        `Lost upstream addition: ${path}`,
    );
}

const deleted = git("diff", "--name-only", "--diff-filter=D", local);

assert.equal(deleted, "", "No existing fork files should be deleted");

for (const path of [
    "src/server/linked-chats.ts",
    "src/server/extensions/agent-teams.ts",
    "web/linked-chats.js",
]) {
    assert.equal(
        git("hash-object", "--", path),
        git("rev-parse", `${local}:${path}`),
        `${path} changed`,
    );
}

const app = readFileSync(new URL("../src/server/app.ts", import.meta.url), "utf8");
const spend = readFileSync(new URL("../src/server/spend.ts", import.meta.url), "utf8");

assert.ok(!app.includes(".teamRoot(") && !app.includes(".budgetSpent("));
assert.ok(!spend.includes("#teamSpent(") && !spend.includes("teamRoot("));
assert.ok(!existsSync(new URL("../src/server/linked-sessions.ts", import.meta.url)));
console.log(
    JSON.stringify(
        {
            local,
            upstream,
            forkOnlyFiles: forkOnly.length,
            changedForkOnly,
            upstreamOnlyFiles: upstreamOnly.length,
            deletedForkFiles: 0,
        },
        null,
        2,
    ),
);
