// SDK metadata ordering remains stable when custom messages acquire native positions.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { mergeSdkEntries } from "../src/server/terminal/entries.ts";

const timestamp = new Date(0).toISOString();
const session: FileEntry = { type: "session", version: 3, id: "session", timestamp, cwd: "/tmp" };
const native = (id: string): SessionEntry => ({
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: { role: "user", content: id, timestamp: 0 },
});
const custom = (id: string): SessionEntry => ({
    type: "custom",
    id,
    parentId: null,
    timestamp,
    customType: "fixture",
    data: { id },
});
const ids = (entries: FileEntry[]) => entries.map((entry) => entry.id);

test("admitted messages fence later ledger entries without moving ordinary native history", () => {
    const b = custom("B");
    const merged = mergeSdkEntries(
        [session, native("X"), native("Y"), b, native("Z")],
        [
            { entry: custom("A"), after: "X" },
            { entry: b, after: "X" },
            { entry: custom("C"), after: "X" },
            { entry: custom("D"), after: "Y" },
            { entry: custom("E"), after: "Z" },
        ],
    );

    assert.deepEqual(ids(merged), ["session", "X", "A", "Y", "B", "C", "D", "Z", "E"]);
    assert.equal(merged.filter((entry) => entry.id === "B").length, 1);
    let previous: string | null = null;

    for (const entry of merged) {
        if (entry.type !== "session") {
            assert.equal(entry.parentId, previous);
            previous = entry.id;
        }
    }
});

test("pending worker effects follow the committed SDK tail even with an older ordinary anchor", () => {
    assert.deepEqual(
        ids(
            mergeSdkEntries(
                [session, native("X"), native("Y"), custom("B"), custom("C"), native("Z")],
                [{ entry: custom("D"), after: "Y" }],
                "C",
            ),
        ),
        ["session", "X", "Y", "B", "C", "D", "Z"],
    );
});

test("unknown live anchors retain ledger order at the tail until native publication", () => {
    assert.deepEqual(
        ids(
            mergeSdkEntries(
                [session, native("X")],
                [
                    { entry: custom("A"), after: "live-response" },
                    { entry: custom("B"), after: "X" },
                ],
            ),
        ),
        ["session", "X", "A", "B"],
    );
});

test("null anchors and additional-entry anchors retain a single correctly linked copy", () => {
    assert.deepEqual(
        ids(
            mergeSdkEntries(
                [],
                [
                    { entry: custom("A"), after: null },
                    { entry: custom("B"), after: "A" },
                    { entry: custom("A"), after: null },
                ],
            ),
        ),
        ["A", "B"],
    );
});
