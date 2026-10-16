/** Connect isolated extension code to Pocket policy, durable effects, tool selection and portable UI. */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, TSchema } from "@earendil-works/pi-ai";
import {
    AgentDoc,
    defineExtension,
    LiveDoc,
    type ConversationId,
    type EntryId,
    type HookApi,
    type Registry,
    type TaskId,
    type ToolExecutionApi,
    type ToolExecutionResult,
    type Tx,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import type { User } from "../config.ts";
import { TerminalStateDoc, TerminalWorkDoc, type TerminalExtensionSelection } from "../docs.ts";
import { HttpError } from "../errors.ts";
import { BUILT_IN_TOOLS } from "../reload.ts";
import { POCKET_COMMAND_NAMES, extensionInput } from "./commands.ts";
import { ExtensionHost } from "./host.ts";
import { answerIdentity, terminalSnapshot, TERMINAL_TOOLS_PREFIX } from "./projection.ts";
import {
    MAX_PACKET_BYTES,
    MAX_REQUEST_BYTES,
    parseHostToolDecision,
    parseHostToolResult,
    wireValue,
    type HostDialog,
    type HostLogEntry,
    type HostOperation,
    type HostReady,
    type HostTool,
} from "./protocol.ts";
import { TerminalStore } from "./store.ts";
import { RequestBudget, type RequestReservation } from "./request-budget.ts";

const context = BACKGROUND_CONTEXT;

export const TERMINAL_EXTENSION = "pocket-terminal";
const MAX_HOSTS = 8;
const IDLE_MS = 5 * 60_000;

type Hosted = {
    host: ExtensionHost;
    cwd: string;
    trusted: boolean;
    catalogue: Pick<HostReady, "commands" | "tools">;
    used: number;
    inflight: number;
};
type HostSlot = {
    cwd: string;
    trusted: boolean;
    promise: Promise<Hosted>;
    child?: ExtensionHost;
    hosted?: Hosted;
    cancelled: boolean;
    disposing?: Promise<void>;
};
export type TerminalDialog = HostDialog & {
    id: string;
    conversationId: number;
    requestedBy: string;
};
type Waiting = {
    request: TerminalDialog;
    operation: string;
    expiresAt: number;
    resolve(value: string | boolean | null): void;
};

/** Remove only our overlay when native code changes the selection after startup. */
function baseExtensions(
    selection: string[] | { add?: string[]; remove?: string[] } | undefined,
    previous?: TerminalExtensionSelection,
): TerminalExtensionSelection {
    const originallyIncluded =
        previous?.mode === "only"
            ? previous.names.includes(TERMINAL_EXTENSION)
            : previous?.mode === "modify" && previous.add?.includes(TERMINAL_EXTENSION);
    const keep = (name: string) =>
        !name.startsWith(TERMINAL_TOOLS_PREFIX) &&
        !(previous && !originallyIncluded && name === TERMINAL_EXTENSION);

    if (Array.isArray(selection)) {
        return { mode: "only", names: selection.filter(keep) };
    }

    if (!selection) {
        return { mode: "all" };
    }

    let remove = selection.remove?.filter((name) => !name.startsWith(TERMINAL_TOOLS_PREFIX));
    const excludedAt =
        previous?.mode === "modify" ? previous.remove?.indexOf(TERMINAL_EXTENSION) : undefined;

    if (excludedAt !== undefined && excludedAt >= 0 && !remove?.includes(TERMINAL_EXTENSION)) {
        remove ??= [];
        remove.splice(Math.min(excludedAt, remove.length), 0, TERMINAL_EXTENSION);
    }

    return {
        mode: "modify",
        ...(selection.add ? { add: selection.add.filter(keep) } : {}),
        ...(remove ? { remove } : {}),
    };
}

export class TerminalManager {
    readonly #app: PocketApp;
    readonly store: TerminalStore;
    readonly #hosts = new Map<ConversationId, HostSlot>();
    readonly #requests = new RequestBudget();
    readonly #running = new Map<string, Promise<JsonValue>>();
    readonly #dialogs = new Map<string, Waiting>();
    readonly #errors = new Map<ConversationId, string>();
    readonly #draining = new Map<ConversationId, Promise<void>>();
    readonly #seen = new Set<ConversationId>();
    readonly #reasons = new Map<ConversationId, "reload" | "resume">();
    #registry: Registry | undefined;
    #timer: ReturnType<typeof setInterval> | undefined;
    #unsubscribe: (() => void) | undefined;
    #closing = false;

    constructor(app: PocketApp) {
        this.#app = app;
        this.store = new TerminalStore(app);
    }

    attach(registry: Registry): void {
        this.#registry = registry;
        this.#timer = setInterval(() => {
            void this.#maintain().catch(() => {});
        }, 1000);
        this.#timer.unref();
        this.#unsubscribe = this.#app.spend.onLimitsChanged(() => {
            for (const id of this.#seen) {
                void this.drain(id);
            }
        });
    }

    known(id: ConversationId): boolean {
        return this.#seen.has(id);
    }

    get enabled(): boolean {
        return (
            !this.#closing &&
            this.#app.loader?.extensionNames().includes(TERMINAL_EXTENSION) === true
        );
    }

    #actor(id: ConversationId): User {
        const by = this.#app.attribution.requesterOf(id) ?? this.#app.sessionMeta(id)?.createdBy;
        const user = by
            ? this.#app.config.userById(by)
            : this.#app.config.users.find((user) => user.role === "owner");

        if (!user) {
            throw new HttpError(403, "No authorized requester for this extension work");
        }

        return user;
    }

    #key(id: ConversationId, operation: string): string {
        return createHash("sha256").update(`${id}:${operation}`).digest("hex");
    }

    #problem(id: ConversationId, error: unknown): void {
        const text = error instanceof Error ? error.message : String(error);

        this.#errors.set(id, text);
        this.#app.notice("warning", `Pi extension: ${text}`, id);
        this.#app.refreshViews();
    }

    async #ensure(
        id: ConversationId,
        by: User,
        executionContext: Context = context,
    ): Promise<Hosted> {
        executionContext.abortSignal?.throwIfAborted();

        if (!this.enabled || this.#app.pip.ownerOf(id) !== undefined) {
            throw new HttpError(409, "Terminal extensions are off for this conversation");
        }

        this.#app.requireSee(by, id);
        await this.#app.requireDriver(id, by);
        executionContext.abortSignal?.throwIfAborted();
        const cwd = this.#app.cwdOf(id);
        const owner = this.#app.config.users.find((user) => user.role === "owner")!;
        const trusted = this.#app.projectTrust(id, owner).trusted;
        const existing = this.#hosts.get(id);

        if (existing) {
            if (
                existing.cwd === cwd &&
                existing.trusted === trusted &&
                !existing.cancelled &&
                !existing.child?.closed
            ) {
                const current = await existing.promise;

                current.used = Date.now();

                return current;
            }

            await this.#discard(id, existing, "reload");

            return this.#ensure(id, by, executionContext);
        }

        if (this.#hosts.size >= MAX_HOSTS) {
            for (const [other, pending] of this.#hosts) {
                const candidate = pending.hosted;

                if (
                    candidate &&
                    candidate.inflight === 0 &&
                    !this.#app.isBusy(other) &&
                    !(await this.store.hasPending(other))
                ) {
                    await this.#discard(other, pending, "resume");
                    break;
                }
            }
        }

        if (this.#hosts.size >= MAX_HOSTS) {
            throw new HttpError(
                409,
                "All Pi extension hosts are busy; retry when another conversation finishes",
            );
        }

        // Capacity eviction may have yielded. Publish each reservation without awaiting anything.
        executionContext.abortSignal?.throwIfAborted();

        if (
            this.#hosts.has(id) ||
            cwd !== this.#app.cwdOf(id) ||
            trusted !== this.#app.projectTrust(id, owner).trusted
        ) {
            return this.#ensure(id, by, executionContext);
        }

        if (!this.enabled) {
            throw new HttpError(409, "Terminal extensions are off for this conversation");
        }

        const pending = Promise.withResolvers<Hosted>();
        const slot: HostSlot = { cwd, trusted, promise: pending.promise, cancelled: false };

        this.#hosts.set(id, slot);
        this.#seen.add(id);
        void this.#open(id, by, slot).then(pending.resolve, pending.reject);

        try {
            return await slot.promise;
        } catch (error) {
            if (this.#hosts.get(id) === slot) {
                this.#hosts.delete(id);
            }

            if (!slot.cancelled) {
                this.#problem(id, error);
            }

            throw error;
        }
    }

    async #initializeHost(id: ConversationId, slot: HostSlot): Promise<ExtensionHost> {
        const reservation = this.#requests.reserve();

        try {
            const snapshot = await terminalSnapshot(this.#app, id);

            reservation.resize(
                Math.min(
                    MAX_REQUEST_BYTES,
                    Buffer.byteLength(JSON.stringify(snapshot)) + MAX_PACKET_BYTES,
                ),
            );

            if (slot.cancelled) {
                throw new Error("Pi extension host startup was cancelled");
            }

            return await ExtensionHost.open({
                cwd: slot.cwd,
                agentDir: this.#app.host.agentDir,
                trusted: slot.trusted,
                snapshot,
                onSpawn: (child) => {
                    slot.child = child;
                },
                onDialog: (operation, dialogId, dialog) =>
                    this.#ask(id, operation, dialogId, dialog),
                onExit: (error) => {
                    if (!this.#closing) {
                        this.#problem(id, error);
                    }
                },
            });
        } finally {
            reservation.release();
        }
    }

    async #open(id: ConversationId, by: User, slot: HostSlot): Promise<Hosted> {
        // Initialization releases its reservation before session_start takes another one.
        const host = await this.#initializeHost(id, slot);
        const { cwd, trusted } = slot;
        const hosted: Hosted = {
            host,
            cwd,
            trusted,
            catalogue: host.catalogue,
            used: Date.now(),
            inflight: 0,
        };

        try {
            if (slot.cancelled) {
                throw new Error("Pi extension host startup was cancelled");
            }

            this.#install(id, hosted.catalogue.tools);
            const state = await this.#app.harness.snapshot(TerminalStateDoc, id, context);
            const reason =
                this.#reasons.get(id) ??
                (this.#app.sessionMeta(id)?.forkedFrom ? "fork" : state ? "resume" : "new");

            this.#reasons.delete(id);
            await this.#invoke(id, hosted, by, `boot-${host.id}`, { kind: "start", reason });

            for (const error of host.catalogue.errors) {
                this.#problem(id, `${basename(error.source)}: ${error.message}`);
            }

            if (slot.cancelled) {
                throw new Error("Pi extension host startup was cancelled");
            }

            slot.hosted = hosted;

            return hosted;
        } catch (error) {
            await host.close();

            throw error;
        }
    }

    #install(id: ConversationId, tools: HostTool[]): void {
        const registry = this.#registry;

        if (!registry) {
            throw new Error("Terminal extensions have no Pocket registry");
        }

        const native = new Set(
            registry
                .snapshot()
                .installed()
                .filter((extension) => !extension.name.startsWith(TERMINAL_TOOLS_PREFIX))
                .flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)),
        );

        for (const tool of tools) {
            if (BUILT_IN_TOOLS.has(tool.name) || native.has(tool.name)) {
                throw new Error(
                    `Pi extension tool ${tool.name} collides with a native Pocket tool (${basename(tool.source)})`,
                );
            }
        }

        registry.install(
            defineExtension({
                name: `${TERMINAL_TOOLS_PREFIX}${id}`,
                tools: tools
                    .filter((tool) => tool.exposure !== "hidden")
                    .map((tool) => ({
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters as TSchema,
                        replay: "unsafe" as const,
                        executionMode: "sequential" as const,
                        execute: async (args, api, executionContext) => {
                            const result = await this.tool(
                                id === api.conversationId ? id : api.conversationId,
                                tool.name,
                                args,
                                api,
                                executionContext,
                            );
                            const decoded = parseHostToolResult(result);

                            return {
                                content: decoded.content,
                                details: decoded.details,
                                isError: decoded.isError,
                                ...(decoded.usage ? { usage: decoded.usage } : {}),
                                ...(decoded.terminate
                                    ? { control: { terminate: true as const } }
                                    : {}),
                            };
                        },
                    })),
            }),
        );
    }

    async #configure(
        tx: Tx,
        id: ConversationId,
        hosted: Hosted,
        effects: readonly HostLogEntry[],
    ): Promise<void> {
        const changed = effects.findLast((item) => item.effect.kind === "catalogue")?.effect;
        const catalogue = changed?.kind === "catalogue" ? changed.catalogue : hosted.catalogue;

        this.#install(id, catalogue.tools);
        const agent = await tx.doc(AgentDoc, id);
        const state = await tx.doc(TerminalStateDoc, id);
        const name = `${TERMINAL_TOOLS_PREFIX}${id}`;

        if (state.baseTools === undefined) {
            state.baseTools = Array.isArray(agent.tools)
                ? { mode: "only", names: [...agent.tools] }
                : agent.tools
                  ? { mode: "remove", names: [...agent.tools.remove] }
                  : { mode: "all" };
        }

        if (
            state.baseExtensions === undefined ||
            (state.baseExtensionsApplied !== undefined &&
                state.baseExtensionsApplied !== JSON.stringify(agent.extensions))
        ) {
            state.baseExtensions = baseExtensions(agent.extensions, state.baseExtensions);
        }

        const keep = (name: string) =>
            name !== TERMINAL_EXTENSION && !name.startsWith(TERMINAL_TOOLS_PREFIX);

        if (Array.isArray(agent.extensions)) {
            agent.extensions = [TERMINAL_EXTENSION, ...agent.extensions.filter(keep), name];
        } else {
            agent.extensions = {
                add: [TERMINAL_EXTENSION, ...(agent.extensions?.add ?? []).filter(keep), name],
                remove: (agent.extensions?.remove ?? []).filter(keep),
            };
        }

        state.baseExtensionsApplied = JSON.stringify(agent.extensions);
        const selection = effects.findLast((item) => item.effect.kind === "tools")?.effect;

        if (selection?.kind === "tools") {
            agent.tools = [...selection.names];
        }
    }

    async #invoke(
        id: ConversationId,
        hosted: Hosted,
        by: User,
        key: string,
        operation: HostOperation,
        executionContext: Context = context,
        pending?: { task: TaskId; message: AssistantMessage },
    ): Promise<JsonValue> {
        // Admission must precede both snapshot construction and the durable operation marker.
        const reservation = this.#requests.reserve();

        try {
            return await this.#invokeReserved(
                id,
                hosted,
                by,
                key,
                operation,
                reservation,
                executionContext,
                pending,
            );
        } finally {
            reservation.release();
        }
    }

    async #invokeReserved(
        id: ConversationId,
        hosted: Hosted,
        by: User,
        key: string,
        operation: HostOperation,
        reservation: RequestReservation,
        executionContext: Context,
        pending?: { task: TaskId; message: AssistantMessage },
    ): Promise<JsonValue> {
        const begun = await this.store.begin(id, key, by, hosted.host.id);

        if (begun.status === "done") {
            return begun.result;
        }

        hosted.inflight++;

        try {
            const snapshot = await terminalSnapshot(this.#app, id, pending);

            reservation.resize(
                Math.min(
                    MAX_REQUEST_BYTES,
                    Buffer.byteLength(JSON.stringify(snapshot)) + MAX_PACKET_BYTES,
                ),
            );
            const log = await hosted.host.invoke(
                key,
                operation,
                snapshot,
                executionContext.abortSignal,
            );
            const applied = await this.store.apply(id, hosted.host.id, log, (tx, effects) =>
                this.#configure(tx, id, hosted, effects),
            );

            hosted.host.acknowledge(applied.through);
            hosted.catalogue = hosted.host.catalogue;
            this.#errors.delete(id);

            for (const item of applied.effects) {
                if (item.effect.kind === "notify") {
                    this.#app.notice(item.effect.level, item.effect.message, id);
                } else if (item.effect.kind === "editor") {
                    const requestedBy = (await this.store.lookup(id, item.operation))?.by;

                    for (const client of this.#app.clients) {
                        if (client.conversationId === id && client.user.id === requestedBy) {
                            client.send("terminal-editor", {
                                conversationId: Number(id),
                                text: item.effect.text,
                            });
                        }
                    }
                }
            }

            if (applied.effects.some((item) => item.effect.kind === "abort")) {
                await this.store.stop(id, async () => {});
                setImmediate(() => {
                    void this.#app.commands
                        .abort(id, by)
                        .catch((error) => this.#problem(id, error));
                });
            } else {
                await this.drain(id);
            }

            this.#app.refreshViews();

            return await this.store.result(id, key);
        } catch (error) {
            if (!this.#closing) {
                await this.store
                    .interrupt(
                        id,
                        hosted.host.id,
                        error instanceof Error ? error.message : String(error),
                    )
                    .catch(() => {});
                this.#problem(id, error);
            }

            await hosted.host.close();

            throw error;
        } finally {
            hosted.inflight--;
            hosted.used = Date.now();
            this.#cancelDialogs(id, key);
        }
    }

    async prepare(
        id: ConversationId,
        by?: User,
        executionContext: Context = context,
    ): Promise<void> {
        if (!this.enabled || this.#app.pip.ownerOf(id) !== undefined) {
            return;
        }

        executionContext.abortSignal?.throwIfAborted();

        const abort = () => {
            void this.evict(id, "resume").catch(() => {});
        };

        executionContext.abortSignal?.addEventListener("abort", abort, { once: true });

        try {
            await this.#ensure(id, by ?? this.#actor(id), executionContext);
        } catch (error) {
            // Native chat remains usable; explicit plugin command/tool paths still fail visibly.
            if (!executionContext.abortSignal?.aborted) {
                this.#problem(id, error);
            }
        } finally {
            executionContext.abortSignal?.removeEventListener("abort", abort);
        }

        executionContext.abortSignal?.throwIfAborted();
    }

    async catalogue(id: ConversationId, by: User) {
        this.#app.requireSee(by, id);

        if (!this.enabled || this.#app.pip.ownerOf(id) !== undefined) {
            return [];
        }

        try {
            await this.#app.requireDriver(id, by);
        } catch {
            const existing = this.#hosts.get(id);

            return existing ? (await existing.promise).catalogue.commands : [];
        }

        return (await this.#ensure(id, by)).catalogue.commands;
    }

    async match(id: ConversationId, by: User, text: string) {
        const parsed = extensionInput(text);

        if (!parsed || !this.enabled) {
            return undefined;
        }

        if (
            !parsed.qualified &&
            (POCKET_COMMAND_NAMES.has(parsed.name.toLowerCase()) ||
                parsed.name.startsWith("skill:") ||
                parsed.name.startsWith("template:") ||
                this.#app.promptTemplates(id).some((template) => template.name === parsed.name))
        ) {
            return undefined;
        }

        const commands = await this.catalogue(id, by);

        if (parsed.qualified || commands.some((command) => command.name === parsed.name)) {
            return parsed;
        }

        return undefined;
    }

    async command(
        id: ConversationId,
        by: User,
        name: string,
        args: string,
        requestId: string,
    ): Promise<JsonValue> {
        this.#app.requireSee(by, id);
        await this.#app.requireDriver(id, by);

        if (!this.enabled) {
            throw new HttpError(409, "Terminal extensions are off");
        }

        const key = this.#key(id, `command:${by.id}:${requestId}`);
        const local = `${id}:${key}`;
        const existing = this.#running.get(local);

        if (existing) {
            return existing;
        }

        const running = (async () => {
            const recorded = await this.store.lookup(id, key);

            if (recorded && recorded.by !== by.id) {
                throw new HttpError(403, "This extension request belongs to another person");
            }

            if (recorded?.status === "done") {
                await this.drain(id);

                return recorded.result;
            }

            if (recorded) {
                throw new HttpError(
                    409,
                    recorded.status === "interrupted"
                        ? recorded.error
                        : "This extension operation was interrupted and was not replayed",
                );
            }

            const hosted = await this.#ensure(id, by);

            if (!hosted.catalogue.commands.some((command) => command.name === name)) {
                throw new HttpError(
                    404,
                    `Pi extension command /${name} is no longer available; refresh the command list`,
                );
            }

            return this.#invoke(id, hosted, by, key, { kind: "command", name, args });
        })();

        this.#running.set(local, running);

        try {
            return await running;
        } finally {
            this.#running.delete(local);
        }
    }

    async tool(
        id: ConversationId,
        name: string,
        args: unknown,
        api: ToolExecutionApi,
        executionContext: Context,
    ): Promise<JsonValue> {
        const by = this.#actor(id);
        const hosted = await this.#ensure(id, by);

        return this.#invoke(
            id,
            hosted,
            by,
            this.#key(id, `tool:${api.taskId}:${api.callId}`),
            { kind: "tool", name, callId: api.callId, args: wireValue(args) },
            executionContext,
        );
    }

    async event(
        id: ConversationId,
        key: string,
        value: Record<string, unknown>,
        executionContext: Context = context,
        pending?: { task: TaskId; message: AssistantMessage },
    ): Promise<JsonValue> {
        if (!this.enabled || this.#app.pip.ownerOf(id) !== undefined) {
            return null;
        }

        const operationKey = this.#key(id, key);
        const recorded = await this.store.lookup(id, operationKey);

        if (recorded?.status === "done") {
            return recorded.result;
        }

        const by = this.#actor(id);
        const hosted = await this.#ensure(id, by);

        return this.#invoke(
            id,
            hosted,
            by,
            operationKey,
            { kind: "event", event: wireValue(value) as Record<string, JsonValue> },
            executionContext,
            pending,
        );
    }

    async messageEnd(
        api: HookApi,
        message: AssistantMessage,
        executionContext: Context,
    ): Promise<void> {
        // afterResponse runs before Durable classifies retries/overflow recovery. A task can therefore
        // emit several distinct terminal responses; repeated delivery of the exact response is one event.
        const response = createHash("sha256").update(JSON.stringify(message)).digest("hex");

        await this.event(
            api.conversationId,
            `turn:${api.taskId}:message-end:${response}`,
            {
                type: "message_end",
                message,
            },
            executionContext,
            { task: api.taskId, message },
        );
    }

    async assistant(id: EntryId): Promise<AssistantMessage | undefined> {
        const row = await this.#app.harness.commit((tx) => tx.entry(id), context);
        const message = row?.model?.[0];

        return message?.role === "assistant" ? message : undefined;
    }

    async #turnIndex(api: HookApi, executionContext: Context): Promise<number> {
        const saved = await api.memo<number>("pocket.terminal-turn-index", executionContext);

        if (saved !== undefined) {
            return saved;
        }

        const live = await this.#app.harness.snapshot(LiveDoc, api.conversationId, context);
        const first = live?.run?.inputs[0];
        const input =
            first === undefined
                ? undefined
                : await (await this.#app.harness.submission(first, context))?.status(context);
        const tasks = new Set<number>();
        let cursor: import("@earendil-works/pi-durable").Cursor | undefined;

        do {
            const page = await (
                await this.#app.conversation(api.conversationId)
            ).entries({ minEntryId: input?.entry, order: "ascending" }, 256, cursor, context);

            for (const row of page.items) {
                const message = row.model?.[0];

                if (
                    row.byTaskId !== undefined &&
                    row.byTaskId !== api.taskId &&
                    message?.role === "assistant" &&
                    message.stopReason !== "error" &&
                    message.stopReason !== "aborted"
                ) {
                    tasks.add(Number(row.byTaskId));
                }
            }

            cursor = page.next;
        } while (cursor !== undefined);

        return api.memo("pocket.terminal-turn-index", tasks.size, executionContext);
    }

    async turnStart(api: HookApi, executionContext: Context): Promise<void> {
        if (!this.enabled) {
            return;
        }

        const live = await this.#app.harness.snapshot(LiveDoc, api.conversationId, context);
        const run = live?.run?.inputs[0] ?? String(api.taskId);

        await this.event(
            api.conversationId,
            `run:${run}:start`,
            { type: "agent_start" },
            executionContext,
        );
        await this.event(
            api.conversationId,
            `turn:${api.taskId}:start`,
            {
                type: "turn_start",
                turnIndex: await this.#turnIndex(api, executionContext),
                timestamp: Date.now(),
            },
            executionContext,
        );
    }

    async turnEnd(
        api: HookApi,
        message: AssistantMessage,
        executionContext: Context,
        results: readonly EntryId[] = [],
        final = true,
    ): Promise<void> {
        if (!this.enabled) {
            return;
        }

        const toolRows = await this.#app.harness.commit(async (tx) => {
            const rows = [];

            for (const id of results) {
                const row = await tx.entry(id);

                if (row) {
                    rows.push(row);
                }
            }

            return rows;
        }, context);
        const pending = { task: api.taskId, message };

        await this.event(
            api.conversationId,
            `turn:${api.taskId}:end`,
            {
                type: "turn_end",
                turnIndex: await this.#turnIndex(api, executionContext),
                message,
                messageEntryId: answerIdentity(api.taskId),
                toolResults: toolRows.flatMap((row) => row.model ?? []),
                toolResultEntryIds: results.map(String),
                outcome: "completed",
            },
            executionContext,
            pending,
        );

        if (final) {
            await this.event(
                api.conversationId,
                `turn:${api.taskId}:agent-end`,
                {
                    type: "agent_end",
                    messages: [message, ...toolRows.flatMap((row) => row.model ?? [])],
                },
                executionContext,
                pending,
            );
            await this.event(
                api.conversationId,
                `turn:${api.taskId}:settle`,
                { type: "agent_before_settle", outcome: "completed" },
                executionContext,
                pending,
            );
        }
    }

    async beforeTool(
        call: { id: string; name: string; arguments: unknown },
        api: HookApi,
        executionContext: Context,
    ) {
        const result = await this.event(
            api.conversationId,
            `tool:${api.taskId}:${call.id}:before`,
            { type: "tool_call", toolCallId: call.id, toolName: call.name, input: call.arguments },
            executionContext,
        );

        if (result === null) {
            return undefined;
        }

        const decoded = parseHostToolDecision(result);

        return decoded.block
            ? { block: decoded.reason ?? "Blocked by a Pi extension" }
            : { arguments: decoded.input };
    }

    async afterTool(
        call: { id: string; name: string; arguments: unknown },
        result: ToolExecutionResult,
        api: HookApi,
        executionContext: Context,
    ) {
        const changed = await this.event(
            api.conversationId,
            `tool:${api.taskId}:${call.id}:after`,
            {
                type: "tool_result",
                toolCallId: call.id,
                toolName: call.name,
                input: call.arguments,
                content: result.content ?? [],
                details: result.details,
                isError: result.isError ?? false,
                usage: result.usage,
            },
            executionContext,
        );

        return changed === null
            ? undefined
            : {
                  ...result,
                  ...parseHostToolResult({
                      ...result,
                      ...Object(changed),
                      content:
                          changed &&
                          typeof changed === "object" &&
                          !Array.isArray(changed) &&
                          "content" in changed
                              ? changed.content
                              : (result.content ?? []),
                  }),
              };
    }

    async drain(id: ConversationId): Promise<void> {
        if (this.#closing || !this.enabled) {
            return;
        }

        const running = this.#draining.get(id);

        if (running) {
            return running;
        }

        const task = (async () => {
            const result = await this.store.drain(id);

            for (const error of result.blocked) {
                this.#problem(id, error);
            }

            if (await this.store.hasPending(id)) {
                setImmediate(() => {
                    if (this.enabled) {
                        void this.drain(id);
                    }
                });
            }
        })().catch((error) => this.#problem(id, error));

        this.#draining.set(id, task);

        try {
            await task;
        } finally {
            this.#draining.delete(id);
        }
    }

    #ask(
        id: ConversationId,
        operation: string,
        dialogId: string,
        dialog: HostDialog,
    ): Promise<string | boolean | null> {
        return (async () => {
            const work = await this.#app.harness.snapshot(TerminalWorkDoc, id, context);
            const source = work?.operations[operation];

            if (
                !source ||
                source.status !== "started" ||
                this.#hosts.get(id)?.cancelled !== false
            ) {
                throw new Error("Extension dialog has no live requesting operation");
            }

            const request: TerminalDialog = {
                ...dialog,
                id: dialogId,
                conversationId: Number(id),
                requestedBy: source.by,
            };

            return new Promise<string | boolean | null>((resolve) => {
                const expiresAt = dialog.expiresAt ?? Date.now() + dialog.timeout;

                const finish = (value: string | boolean | null) => {
                    clearTimeout(timer);
                    this.#dialogs.delete(dialogId);
                    resolve(value);
                    this.#app.refreshViews();
                };

                const timer = setTimeout(() => finish(null), Math.max(0, expiresAt - Date.now()));

                this.#dialogs.set(dialogId, { request, operation, expiresAt, resolve: finish });
                this.#app.refreshViews();
            });
        })();
    }

    dialogs(id: ConversationId, by: User): TerminalDialog[] {
        return [...this.#dialogs.values()]
            .filter(
                (item) =>
                    item.request.conversationId === Number(id) &&
                    item.request.requestedBy === by.id &&
                    by.role !== "viewer",
            )
            .map((item) => item.request);
    }

    problem(id: ConversationId, by: User): string | null {
        const error = this.#errors.get(id);

        return error
            ? by.role === "owner"
                ? error
                : "A Pi extension failed; ask the owner to inspect or reload it."
            : null;
    }

    async answer(id: ConversationId, by: User, dialogId: string, value: unknown): Promise<void> {
        this.#app.requireSee(by, id);
        await this.#app.requireDriver(id, by);
        const pending = this.#dialogs.get(dialogId);

        if (pending && pending.expiresAt <= Date.now()) {
            pending.resolve(null);
        }

        if (
            !pending ||
            pending.expiresAt <= Date.now() ||
            pending.request.conversationId !== Number(id)
        ) {
            throw new HttpError(404, "This extension dialog is no longer waiting");
        }

        if (pending.request.requestedBy !== by.id) {
            throw new HttpError(403, "This extension dialog belongs to another person");
        }

        if (
            value !== null &&
            (pending.request.kind === "confirm"
                ? typeof value !== "boolean"
                : typeof value !== "string" || value.length > 100_000)
        ) {
            throw new HttpError(400, "Invalid extension dialog answer");
        }

        if (
            pending.request.kind === "select" &&
            typeof value === "string" &&
            !pending.request.options?.includes(value)
        ) {
            throw new HttpError(400, "Choose an offered extension option");
        }

        this.#dialogs.delete(dialogId);
        pending.resolve(value as string | boolean | null);
        this.#app.refreshViews();
    }

    #cancelDialogs(id?: ConversationId, operation?: string): void {
        for (const [key, waiting] of this.#dialogs) {
            if (
                (id === undefined || waiting.request.conversationId === Number(id)) &&
                (operation === undefined || waiting.operation === operation)
            ) {
                this.#dialogs.delete(key);
                waiting.resolve(null);
            }
        }

        this.#app.refreshViews();
    }

    disconnected(userId: string): void {
        for (const waiting of [...this.#dialogs.values()]) {
            if (
                waiting.request.requestedBy === userId &&
                ![...this.#app.clients].some(
                    (client) =>
                        client.user.id === userId &&
                        Number(client.conversationId) === waiting.request.conversationId,
                )
            ) {
                this.#cancelDialogs(
                    waiting.request.conversationId as ConversationId,
                    waiting.operation,
                );
            }
        }
    }

    async #discard(id: ConversationId, slot: HostSlot, reason: "reload" | "resume"): Promise<void> {
        if (slot.disposing) {
            return slot.disposing;
        }

        if (this.#hosts.get(id) !== slot) {
            return;
        }

        this.#reasons.set(id, reason);
        slot.cancelled = true;
        this.#cancelDialogs(id);
        slot.disposing = (async () => {
            await slot.child?.close();

            if (slot.child && !this.#closing) {
                await this.store.interrupt(
                    id,
                    slot.child.id,
                    "Pi extension host was disposed; unfinished handlers were not replayed",
                );
            }

            if (this.#hosts.get(id) === slot) {
                this.#hosts.delete(id);
            }
        })();

        return slot.disposing;
    }

    async evict(id: ConversationId, reason: "reload" | "resume"): Promise<void> {
        const slot = this.#hosts.get(id);

        if (slot) {
            await this.#discard(id, slot, reason);
        } else {
            this.#reasons.set(id, reason);
        }
    }

    async #restoreSelection(id: ConversationId): Promise<void> {
        await this.#app.harness.commit(async (tx) => {
            const agent = await tx.doc(AgentDoc, id);
            const state = await tx.doc(TerminalStateDoc, id);

            if (
                state.baseExtensionsApplied !== undefined &&
                state.baseExtensionsApplied !== JSON.stringify(agent.extensions)
            ) {
                state.baseExtensions = baseExtensions(agent.extensions, state.baseExtensions);
            }

            if (Array.isArray(agent.extensions)) {
                agent.extensions = agent.extensions.filter(
                    (name) => !name.startsWith(TERMINAL_TOOLS_PREFIX),
                );
            } else if (agent.extensions) {
                agent.extensions = {
                    add: (agent.extensions.add ?? []).filter(
                        (name) => !name.startsWith(TERMINAL_TOOLS_PREFIX),
                    ),
                    remove: (agent.extensions.remove ?? []).filter(
                        (name) => !name.startsWith(TERMINAL_TOOLS_PREFIX),
                    ),
                };

                if (
                    (agent.extensions.add?.length ?? 0) === 0 &&
                    (agent.extensions.remove?.length ?? 0) === 0
                ) {
                    delete agent.extensions;
                }
            }

            if (state.baseExtensions?.mode === "all") {
                delete agent.extensions;
            } else if (state.baseExtensions?.mode === "only") {
                agent.extensions = [...state.baseExtensions.names];
            } else if (state.baseExtensions?.mode === "modify") {
                agent.extensions = {
                    ...(state.baseExtensions.add ? { add: [...state.baseExtensions.add] } : {}),
                    ...(state.baseExtensions.remove
                        ? { remove: [...state.baseExtensions.remove] }
                        : {}),
                };
            }

            delete state.baseExtensions;
            delete state.baseExtensionsApplied;

            if (state.baseTools?.mode === "all") {
                delete agent.tools;
            } else if (state.baseTools?.mode === "only") {
                agent.tools = [...state.baseTools.names];
            } else if (state.baseTools?.mode === "remove") {
                agent.tools = { remove: [...state.baseTools.names] };
            }

            delete state.baseTools;
            delete state.activeTools;
        }, context);
    }

    async resetHosts(disabled = false): Promise<void> {
        for (const id of this.#seen) {
            if (disabled) {
                await this.store.stop(id, async () => {});
            }

            await this.evict(id, "reload");

            if (disabled) {
                await this.#restoreSelection(id);
            } else if (this.enabled) {
                await this.#ensure(id, this.#actor(id));
            }
        }
    }

    async restore(ids: readonly ConversationId[]): Promise<void> {
        for (const id of ids) {
            const state = await this.#app.harness.snapshot(TerminalStateDoc, id, context);
            const work = await this.#app.harness.snapshot(TerminalWorkDoc, id, context);

            if (!state && !work) {
                continue;
            }

            this.#seen.add(id);

            for (const host of new Set(
                Object.values(work?.operations ?? {})
                    .filter((item) => item.status === "started")
                    .map((item) => item.host),
            )) {
                await this.store.interrupt(
                    id,
                    host,
                    "The server restarted during this extension operation; it was not replayed",
                );
            }

            if (!this.enabled) {
                await this.#restoreSelection(id);
                continue;
            }

            this.#reasons.set(id, "reload");

            if (
                this.#app.isBusy(id) ||
                Object.values(work?.outbox ?? {}).some(
                    (intent) => intent.status === "pending" || intent.status === "blocked",
                )
            ) {
                try {
                    await this.#ensure(id, this.#actor(id));
                } catch (error) {
                    this.#problem(id, error);
                }
            }
        }
    }

    async stop(id: ConversationId, by: User, abort: () => Promise<void>): Promise<void> {
        this.#app.requireSee(by, id);
        this.#app.requireSteer(by);
        await this.store.stop(id, abort);
        await this.evict(id, "reload");
    }

    async #maintain(): Promise<void> {
        for (const waiting of [...this.#dialogs.values()]) {
            const by = this.#app.config.userById(waiting.request.requestedBy);

            try {
                if (!by) {
                    throw new Error("Requester removed");
                }

                this.#app.requireSee(by, waiting.request.conversationId as ConversationId);
                await this.#app.requireDriver(waiting.request.conversationId as ConversationId, by);
            } catch {
                this.#cancelDialogs(
                    waiting.request.conversationId as ConversationId,
                    waiting.operation,
                );
            }
        }

        for (const [id, pending] of this.#hosts) {
            const hosted = pending.hosted;

            if (
                hosted &&
                hosted.inflight === 0 &&
                Date.now() - hosted.used > IDLE_MS &&
                !this.#app.isBusy(id) &&
                !(await this.store.hasPending(id))
            ) {
                await this.#discard(id, pending, "resume");
            }
        }
    }

    beginClosing(): void {
        this.#closing = true;
        clearInterval(this.#timer);
        this.#unsubscribe?.();
        this.#cancelDialogs();

        // Durable shutdown can itself be waiting on a startup hook. Reap first, not after it.
        for (const [id, slot] of this.#hosts) {
            void this.#discard(id, slot, "resume").catch(() => {});
        }
    }

    async close(): Promise<void> {
        this.beginClosing();
        await Promise.all([...this.#hosts].map(([id, slot]) => this.#discard(id, slot, "resume")));
        this.#hosts.clear();
    }
}
