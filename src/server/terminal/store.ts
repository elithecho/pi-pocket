/** Atomic Pocket-owned extension state/effect prefixes and retry-safe admission, never a second SDK session. */
import { createHash } from "node:crypto";
import type { Draft, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import {
    TerminalReceiptDoc,
    TerminalStateDoc,
    TerminalWorkDoc,
    type TerminalWorkState,
    type TerminalIntent,
    type TerminalOperationRecord,
} from "../docs.ts";
import { HttpError } from "../errors.ts";
import { requestFor } from "../requests.ts";
import {
    MAX_PACKET_BYTES,
    parseCustomEntry,
    parseHostEffect,
    wireValue,
    type HostLogEntry,
} from "./protocol.ts";

const context = BACKGROUND_CONTEXT;
const KEEP_SETTLED = 64;
const MAX_SETTLED_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVE = 64;
const MAX_PENDING = 256;
const DRAIN_BATCH = 32;

export type TerminalBegin =
    { status: "started"; epoch: number } | { status: "done"; result: JsonValue };
export type TerminalApplied = { through: number; effects: HostLogEntry[] };

/** Prefix commits, drain and stop share this per-conversation gate so a stop cannot race new admission. */
export class TerminalStore {
    readonly #app: PocketApp;
    readonly #locks = new Map<ConversationId, Promise<void>>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    async #locked<T>(id: ConversationId, change: () => Promise<T>): Promise<T> {
        const previous = this.#locks.get(id) ?? Promise.resolve();

        let release = () => {};

        const next = new Promise<void>((resolve) => {
            release = resolve;
        });

        this.#locks.set(id, next);
        await previous;

        try {
            return await change();
        } finally {
            release();

            if (this.#locks.get(id) === next) {
                this.#locks.delete(id);
            }
        }
    }

    async begin(id: ConversationId, key: string, by: User, host: string): Promise<TerminalBegin> {
        this.#app.requireSee(by, id);
        await this.#app.requireDriver(id, by);
        const outcome = await this.#locked(id, () =>
            this.#app.harness.commit(
                async (tx): Promise<TerminalBegin | { status: "error"; message: string }> => {
                    const work = await tx.doc(TerminalWorkDoc, id);
                    const existing =
                        work.operations[key] ??
                        (await tx.doc(TerminalReceiptDoc, id, key, null)).operation;

                    if (existing) {
                        if (existing.by !== by.id) {
                            throw new HttpError(
                                403,
                                "This extension request belongs to another person",
                            );
                        }

                        if (existing.status === "done") {
                            // Never let a Chord transaction draft escape after its overlay settles.
                            return { status: "done", result: wireValue(existing.result) };
                        }

                        if (existing.status === "interrupted") {
                            return { status: "error", message: existing.error };
                        }

                        if (existing.host !== host) {
                            const message =
                                "The extension operation lost its host; it may have performed external work and was not replayed.";

                            work.operations[key] = {
                                ...existing,
                                status: "interrupted",
                                error: message,
                            };

                            await this.#prune(tx, id, work, host);

                            return { status: "error", message };
                        }

                        return {
                            status: "error",
                            message: "This extension operation is already running",
                        };
                    }

                    if (
                        Object.values(work.operations).filter(
                            (operation) => operation.status === "started",
                        ).length >= MAX_ACTIVE
                    ) {
                        throw new HttpError(
                            409,
                            "Too many unfinished extension operations; finish or interrupt them before starting more",
                        );
                    }

                    const started: TerminalOperationRecord = {
                        by: by.id,
                        host,
                        epoch: work.epoch,
                        status: "started",
                    };

                    work.operations[key] = started;

                    return { status: "started", epoch: work.epoch };
                },
                context,
            ),
        );

        if (outcome.status === "error") {
            throw new HttpError(409, outcome.message);
        }

        return outcome;
    }

    async apply(
        id: ConversationId,
        host: string,
        log: readonly HostLogEntry[],
        configure?: (tx: Tx, effects: readonly HostLogEntry[]) => Promise<void>,
    ): Promise<TerminalApplied> {
        return this.#locked(id, async () => {
            const before = await this.#app.harness.snapshot(TerminalWorkDoc, id, context);
            const seen = before?.acknowledged[host] ?? 0;
            const fresh = log.filter((item) => item.seq > seen);

            for (const key of new Set(fresh.map((item) => item.operation))) {
                const operation = before?.operations[key];
                const by = operation && this.#app.config.userById(operation.by);

                if (!by) {
                    throw new HttpError(
                        403,
                        "The extension operation's requester is no longer available",
                    );
                }

                this.#app.requireSee(by, id);
                await this.#app.requireDriver(id, by);
            }

            return this.#app.harness.commit(async (tx) => {
                const work = await tx.doc(TerminalWorkDoc, id);
                const state = await tx.doc(TerminalStateDoc, id);
                let through = work.acknowledged[host] ?? 0;
                const applied: HostLogEntry[] = [];
                const ids = new Set(state.entries.map((item) => parseCustomEntry(item.sdk).id));

                for (const item of log) {
                    if (item.seq <= through) {
                        continue;
                    }

                    if (item.seq !== through + 1) {
                        throw new Error(
                            "Terminal effect prefix has a missing or reordered sequence",
                        );
                    }

                    const operation = work.operations[item.operation];

                    if (
                        !operation ||
                        operation.status !== "started" ||
                        operation.host !== host ||
                        operation.epoch !== work.epoch
                    ) {
                        throw new Error(
                            "Terminal effect belongs to a stale, interrupted, or unknown operation",
                        );
                    }

                    const value = parseHostEffect(item.effect);

                    switch (value.kind) {
                        case "entry": {
                            if (value.entry.type !== "custom") {
                                throw new Error(
                                    "A custom message must use message admission, not a state-only append",
                                );
                            }

                            if (ids.has(value.entry.id)) {
                                throw new Error(
                                    "Terminal extension generated a duplicate SDK entry identity",
                                );
                            }

                            ids.add(value.entry.id);
                            state.entries.push({ sdk: wireValue(value.entry), after: value.after });
                            break;
                        }

                        case "message": {
                            const key = createHash("sha256")
                                .update(`${host}:${item.seq}`)
                                .digest("hex");
                            const requestId = requestFor(operation.by, key);

                            if (!value.trigger && !value.custom) {
                                throw new Error(
                                    "Passive extension messages need custom-message metadata",
                                );
                            }

                            if (value.custom) {
                                if (ids.has(value.custom.id)) {
                                    throw new Error(
                                        "Terminal extension generated a duplicate SDK message identity",
                                    );
                                }

                                ids.add(value.custom.id);
                                state.entries.push({
                                    sdk: wireValue(value.custom),
                                    after: value.after,
                                    admission: { conversation: Number(id), requestId },
                                });
                            }

                            const intent: TerminalIntent = {
                                status: "pending",
                                key,
                                by: operation.by,
                                epoch: operation.epoch,
                                content: wireValue(value.content),
                                trigger: value.trigger,
                                delivery: value.delivery,
                                expand: value.expand,
                                ...(value.custom ? { custom: wireValue(value.custom) } : {}),
                            };
                            const pending = Object.values(work.outbox).filter(
                                (intent) =>
                                    intent.status === "pending" || intent.status === "blocked",
                            );
                            const size = pending.reduce(
                                (bytes, intent) =>
                                    bytes + Buffer.byteLength(JSON.stringify(intent)),
                                0,
                            );

                            if (
                                pending.length >= MAX_PENDING ||
                                size + Buffer.byteLength(JSON.stringify(intent)) > MAX_PACKET_BYTES
                            ) {
                                throw new Error(
                                    "Too many pending extension messages; resolve or cancel them before adding more",
                                );
                            }

                            work.outbox[key] = intent;
                            break;
                        }

                        case "tools":
                            state.activeTools = [...value.names];
                            break;
                        case "status":
                            if (value.text === null) {
                                delete state.statuses[value.key];
                            } else {
                                state.statuses[value.key] = value.text;
                            }

                            break;
                        case "widget":
                            if (value.lines === null) {
                                delete state.widgets[value.key];
                            } else {
                                state.widgets[value.key] = {
                                    lines: [...value.lines],
                                    placement: value.placement,
                                };
                            }

                            break;
                        case "complete":
                            work.operations[item.operation] = {
                                ...operation,
                                status: "done",
                                result: wireValue(value.result),
                            };
                            break;
                        case "catalogue":
                        case "notify":
                        case "editor":
                        case "abort":
                            // Catalogue/ephemeral UI is applied by the manager only after commit. Abort
                            // is handed back to it so stopping never deadlocks this store's own gate.
                            break;
                    }

                    through = item.seq;
                    applied.push({ ...item, effect: value });
                }

                if (configure && applied.length > 0) {
                    await configure(tx, applied);
                }

                work.acknowledged[host] = through;
                await this.#prune(tx, id, work, host);

                return { through, effects: applied };
            }, context);
        });
    }

    /** Interruption never deletes acknowledged checkpoints and never retries arbitrary plugin code. */
    async interrupt(id: ConversationId, host: string, reason: string): Promise<void> {
        await this.#locked(id, () =>
            this.#app.harness.commit(async (tx) => {
                const work = await tx.doc(TerminalWorkDoc, id);

                for (const [key, operation] of Object.entries(work.operations)) {
                    if (operation.host === host && operation.status === "started") {
                        work.operations[key] = {
                            ...operation,
                            status: "interrupted",
                            error: reason,
                        };
                    }
                }

                await this.#prune(tx, id, work);
            }, context),
        );
    }

    async lookup(
        id: ConversationId,
        key: string,
    ): Promise<Readonly<TerminalOperationRecord> | undefined> {
        return (
            (await this.#app.harness.snapshot(TerminalWorkDoc, id, context))?.operations[key] ??
            (await this.#app.harness.snapshot(TerminalReceiptDoc, id, key, context))?.operation
        );
    }

    async result(id: ConversationId, key: string): Promise<JsonValue> {
        const operation = await this.lookup(id, key);

        if (operation?.status !== "done") {
            throw new Error("Terminal operation has no committed result");
        }

        return operation.result;
    }

    async drain(id: ConversationId): Promise<{ delivered: number; blocked: string[] }> {
        return this.#locked(id, async () => {
            const work = await this.#app.harness.snapshot(TerminalWorkDoc, id, context);
            const blocked: string[] = [];
            let delivered = 0;

            const candidates = Object.entries(work?.outbox ?? {})
                .filter(([, intent]) => intent.status === "pending" || intent.status === "blocked")
                .sort(
                    ([, a], [, b]) =>
                        Number(a.status === "blocked") - Number(b.status === "blocked"),
                )
                .slice(0, DRAIN_BATCH);

            for (const [key, intent] of candidates) {
                const existing = await this.#app.harness.commit(
                    (tx) => tx.submissionByRequest(id, requestFor(intent.by, intent.key)),
                    context,
                );

                if (existing) {
                    await this.#mark(id, key, {
                        ...intent,
                        status: "delivered",
                        submission: Number(existing.id),
                    });
                    delivered++;
                    continue;
                }

                if (intent.epoch !== work!.epoch) {
                    await this.#mark(id, key, {
                        ...intent,
                        status: "cancelled",
                        reason: "The conversation was stopped before this message was admitted",
                    });
                    continue;
                }

                const by = this.#app.config.userById(intent.by);

                if (!by) {
                    const error = "The extension message's requester is no longer available";

                    await this.#mark(id, key, { ...intent, status: "blocked", error });
                    blocked.push(error);
                    continue;
                }

                try {
                    const value = parseHostEffect({
                        kind: "message",
                        content: intent.content,
                        custom: intent.custom,
                        trigger: intent.trigger,
                        delivery: intent.delivery,
                        expand: intent.expand,
                        after: null,
                    });

                    if (value.kind !== "message") {
                        throw new Error("Stored extension message has an invalid kind");
                    }

                    const submitted = await this.#app.commands.submitTerminal(id, by, {
                        key: intent.key,
                        content: value.content,
                        trigger: value.trigger,
                        delivery: value.delivery,
                        expand: value.expand,
                        ...(value.custom ? { custom: value.custom } : {}),
                    });

                    await this.#mark(id, key, {
                        ...intent,
                        status: "delivered",
                        submission: Number(submitted.submissionId),
                    });
                    delivered++;
                } catch (failure) {
                    const error = failure instanceof Error ? failure.message : String(failure);

                    await this.#mark(id, key, { ...intent, status: "blocked", error });
                    blocked.push(error);
                }
            }

            return { delivered, blocked };
        });
    }

    async #mark(id: ConversationId, key: string, intent: TerminalIntent): Promise<void> {
        await this.#app.harness.commit(async (tx) => {
            const work = await tx.doc(TerminalWorkDoc, id);

            work.outbox[key] = intent;
            await this.#prune(tx, id, work);
        }, context);
    }

    /** Settled receipts are cold per-key data; only bounded active/recent indexes are scanned by admission. */
    async #prune(
        tx: Tx,
        id: ConversationId,
        work: Draft<TerminalWorkState>,
        currentHost?: string,
    ): Promise<void> {
        const settled = Object.entries(work.operations).filter(
            ([, operation]) => operation.status !== "started",
        );
        let count = settled.length;
        let bytes = settled.reduce(
            (total, [, operation]) => total + Buffer.byteLength(JSON.stringify(operation)),
            0,
        );

        for (const [key, operation] of settled) {
            if (count <= KEEP_SETTLED && bytes <= MAX_SETTLED_BYTES) {
                break;
            }

            const receipt = await tx.doc(TerminalReceiptDoc, id, key, null);

            receipt.operation =
                operation.status === "done"
                    ? { ...operation, result: wireValue(operation.result) }
                    : { ...operation };
            bytes -= Buffer.byteLength(JSON.stringify(operation));
            count--;
            delete work.operations[key];
        }

        const delivered = Object.entries(work.outbox).filter(
            ([, intent]) => intent.status === "delivered" || intent.status === "cancelled",
        );

        count = delivered.length;
        bytes = delivered.reduce(
            (total, [, intent]) => total + Buffer.byteLength(JSON.stringify(intent)),
            0,
        );

        for (const [key, intent] of delivered) {
            if (count <= KEEP_SETTLED && bytes <= MAX_SETTLED_BYTES) {
                break;
            }

            bytes -= Buffer.byteLength(JSON.stringify(intent));
            count--;
            delete work.outbox[key];
        }

        const liveHosts = new Set(
            Object.values(work.operations)
                .filter((operation) => operation.status === "started")
                .map((operation) => operation.host),
        );
        const oldHosts = Object.keys(work.acknowledged).filter(
            (host) => host !== currentHost && !liveHosts.has(host),
        );

        for (const host of oldHosts.slice(0, Math.max(0, oldHosts.length - 32))) {
            delete work.acknowledged[host];
        }
    }

    async hasPending(id: ConversationId): Promise<boolean> {
        const work = await this.#app.harness.snapshot(TerminalWorkDoc, id, context);

        return Object.values(work?.outbox ?? {}).some((intent) => intent.status === "pending");
    }

    /** Linearize epoch cancellation and native queue withdrawal against the entire admission drain. */
    async stop(id: ConversationId, abort: () => Promise<void>): Promise<void> {
        const { stopped } = await this.#locked(id, async () => {
            await this.#app.harness.commit(async (tx) => {
                const work = await tx.doc(TerminalWorkDoc, id);

                work.epoch++;

                for (const [key, intent] of Object.entries(work.outbox)) {
                    if (intent.status === "pending" || intent.status === "blocked") {
                        work.outbox[key] = {
                            ...intent,
                            status: "cancelled",
                            reason: "Stopped by a person",
                        };
                    }
                }

                for (const [key, operation] of Object.entries(work.operations)) {
                    if (operation.status === "started") {
                        work.operations[key] = {
                            ...operation,
                            status: "interrupted",
                            error: "Stopped by a person; the extension operation was not replayed",
                        };
                    }
                }

                await this.#prune(tx, id, work);
            }, context);

            // Initiate native withdrawal before admitting any later drain, but don't hold this
            // gate while waiting for tools: their cancellation paths may need to interrupt here.
            return { stopped: abort() };
        });

        await stopped;
    }
}
