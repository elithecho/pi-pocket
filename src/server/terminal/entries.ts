/** Merge extension-only state into one selected SDK branch without copying ordinary history into plugin state. */
import type { FileEntry, SessionEntry } from "@earendil-works/pi-coding-agent";

export type AnchoredEntry = { entry: SessionEntry; after: string | null };

export function mergeSdkEntries(
    base: readonly FileEntry[],
    additional: readonly AnchoredEntry[],
    previous?: string,
): FileEntry[] {
    const positions = new Map(base.map((entry, index) => [entry.id, index]));
    const known = new Set(positions.keys());
    const groups = new Map<number, SessionEntry[]>();
    let floor = previous === undefined ? -1 : (positions.get(previous) ?? -1);

    // `additional` is ledger order, including custom messages already present as native rows.
    // Once one is placed, later custom entries cannot move back before it merely because they
    // share an older ordinary-history anchor. Pending worker effects also follow the saved tail.
    for (const item of additional) {
        const placed = positions.get(item.entry.id);

        if (placed !== undefined) {
            floor = Math.max(floor, placed);
            continue;
        }

        if (known.has(item.entry.id)) {
            continue;
        }

        const anchor = item.after === null ? -1 : (positions.get(item.after) ?? base.length);

        floor = Math.max(floor, anchor);
        known.add(item.entry.id);
        positions.set(item.entry.id, floor);
        const group = groups.get(floor) ?? [];

        group.push(item.entry);
        groups.set(floor, group);
    }

    const merged: FileEntry[] = base.filter((entry) => entry.type === "session");

    const insert = (position: number) => {
        merged.push(...(groups.get(position) ?? []));
        groups.delete(position);
    };

    insert(-1);

    for (const [index, entry] of base.entries()) {
        if (entry.type !== "session") {
            merged.push(entry);
            insert(index);
        }
    }

    // A lifecycle response can be live before its Durable row is published. Unknown anchors
    // stay at the live tail without breaking the ledger's relative order.
    insert(base.length);

    let parentId: string | null = null;

    return merged.map((entry) => {
        if (entry.type === "session") {
            return entry;
        }

        const linked = { ...entry, parentId };

        parentId = entry.id;

        return linked;
    });
}
