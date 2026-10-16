/** Isolated plugin runtime only: no model loop, persistent SDK session, or Pocket policy bypass. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import {
    convertToLlm,
    createSyntheticSourceInfo,
    DefaultPackageManager,
    DefaultResourceLoader,
    ExtensionRunner,
    ModelRegistry,
    ModelRuntime,
    SessionManager,
    sessionEntryToContextMessages,
    SettingsManager,
    type ExtensionActions,
    type ExtensionContextActions,
    type ExtensionEvent,
    type FileEntry,
    type SessionProjection,
    type ToolDefinition,
    type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore, type TSchema } from "@earendil-works/pi-ai";
import {
    MAX_EFFECTS,
    parseCustomEntry,
    parseHostEffect,
    wireValue,
    type FromHost,
    type HostCustomEntry,
    type HostDialog,
    type HostEffect,
    type HostLogEntry,
    type HostOperation,
    type HostReady,
    type HostSnapshot,
    type HostTool,
    type ToHost,
    type WireValue,
} from "./protocol.ts";
import { mergeSdkEntries, type AnchoredEntry } from "./entries.ts";
import { RequestDecoder } from "./transport.ts";

type Operation = { id: string; controller: AbortController; errors: string[]; closed: boolean };
const operations = new AsyncLocalStorage<Operation>();
const running = new Map<string, Operation>();
const dialogs = new Map<
    string,
    { operation: string; resolve: (value: string | boolean | null) => void }
>();
let runner: ExtensionRunner | undefined;
let snapshot: HostSnapshot;
let view = SessionManager.inMemory();
let active: string[] = [];
let log: HostLogEntry[] = [];
let sequence = 0;
let closing = false;
const requests = new RequestDecoder();
let knownTools = new Set<string>();
let catalogueFingerprint = "";

// Only events with a production Pocket dispatch path may be registered. Session start uses
// HostOperation.start; the rest pass through event(). Expanding this list requires a parent adapter.
const SUPPORTED_EVENTS = new Set<string>([
    "session_start",
    "agent_start",
    "turn_start",
    "message_end",
    "tool_call",
    "tool_result",
    "turn_end",
    "agent_end",
    "agent_before_settle",
] satisfies ExtensionEvent["type"][]);

function requireMappedEvent(type: string, source: string): void {
    if (!SUPPORTED_EVENTS.has(type)) {
        unsupported(`lifecycle event ${type} registered by ${source}`);
    }
}

function send(packet: FromHost): void {
    if (!process.send || !process.connected) {
        throw new Error("Terminal extension host lost its Pocket connection");
    }

    process.send(wireValue(packet));
}

function unsupported(capability: string): never {
    throw new Error(`Unsupported in Pi Pocket terminal extensions: ${capability}`);
}

function operation(): Operation {
    const current = operations.getStore();

    if (!current || current.closed || current.controller.signal.aborted || closing) {
        throw new Error(
            "Extension effects require a live Pocket operation; detached work is unsupported",
        );
    }

    return current;
}

function effect(value: HostEffect): void {
    const current = operation();

    if (log.length >= MAX_EFFECTS) {
        throw new Error("Terminal extension exceeded the unacknowledged effect limit");
    }

    log.push({ seq: ++sequence, operation: current.id, effect: parseHostEffect(value) });
}

function anchor(): string | null {
    return (
        snapshot.entries.findLast(
            (entry) =>
                !["session", "custom", "custom_message", "context_edit"].includes(entry.type),
        )?.id ?? null
    );
}

function entry(id: string): HostCustomEntry {
    const stored = view.getEntry(id);

    if (!stored) {
        throw new Error("The extension's synchronous session append was lost");
    }

    return parseCustomEntry(stored);
}

function messageEntry(id: string): Extract<HostCustomEntry, { type: "custom_message" }> {
    const value = entry(id);

    if (value.type !== "custom_message") {
        throw new Error("The extension message has no SDK custom-message metadata");
    }

    return value;
}

/** Snapshots are Pocket-created SDK projections, validated as bounded entry envelopes by protocol.ts. */
function refresh(next: HostSnapshot): void {
    const entries = next.entries as FileEntry[];
    const pending: AnchoredEntry[] = [];

    for (const item of log) {
        const value = item.effect;
        const candidate =
            value.kind === "entry"
                ? value.entry
                : value.kind === "message"
                  ? value.custom
                  : undefined;

        if (candidate && (value.kind === "entry" || value.kind === "message")) {
            pending.push({ entry: candidate, after: value.after });
        }
    }

    snapshot = next;
    view = SessionManager.inMemory(
        process.cwd(),
        undefined,
        mergeSdkEntries(entries, pending, next.ledgerTail),
    );
}

function projection(): SessionProjection {
    if (!snapshot.context) {
        return view.buildSessionProjection();
    }

    // Canonical context comes from Pocket's own positional projection, not an independent SDK
    // reconstruction that could disagree about compaction, resets, or arbitrary context edits.
    const entries = [...snapshot.context.entries] as SessionProjection["entries"];
    const messages = [...snapshot.context.messages] as SessionProjection["messages"];
    const known = new Set(entries.map((item) => item.sourceEntry.id));

    for (const item of log) {
        const value = item.effect;
        const entry =
            value.kind === "entry"
                ? value.entry
                : value.kind === "message"
                  ? value.custom
                  : undefined;

        if (entry && !known.has(entry.id)) {
            const added = sessionEntryToContextMessages(entry);

            entries.push({ sourceEntry: entry, messages: added });
            messages.push(...added);
            known.add(entry.id);
        }
    }

    return {
        entries,
        messages,
        thinkingLevel: snapshot.thinkingLevel,
        model: snapshot.model
            ? { provider: snapshot.model.provider, modelId: snapshot.model.id }
            : null,
    };
}

async function ask(dialog: HostDialog): Promise<string | boolean | null> {
    const current = operation();
    const id = randomUUID();
    const expiresAt = Date.now() + dialog.timeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const waiting = new Promise<string | boolean | null>((resolve) => {
        dialogs.set(id, { operation: current.id, resolve });
        timer = setTimeout(() => resolve(null), dialog.timeout);
        cancel = () => resolve(null);
        current.controller.signal.addEventListener("abort", cancel, { once: true });
    });

    send({ type: "dialog", id, operation: current.id, dialog: { ...dialog, expiresAt } });

    try {
        return await waiting;
    } finally {
        clearTimeout(timer);

        if (cancel) {
            current.controller.signal.removeEventListener("abort", cancel);
        }

        dialogs.delete(id);
    }
}

function timeout(value?: number): number {
    return Math.max(1, Math.min(600_000, value ?? 120_000));
}

function definitions(): HostTool[] {
    return runtime()
        .getAllRegisteredTools()
        .map(({ definition, sourceInfo }) => ({
            name: definition.name,
            description: definition.description,
            parameters: wireValue(definition.parameters) as Record<string, WireValue>,
            source: sourceInfo.path,
            exposure: definition.exposure ?? "direct",
            ...(definition.promptGuidelines
                ? { promptGuidelines: definition.promptGuidelines }
                : {}),
        }));
}

function catalogue(): Pick<HostReady, "commands" | "tools"> {
    return {
        commands: runtime()
            .getRegisteredCommands()
            .map((command) => ({
                name: command.invocationName,
                description: command.description ?? "",
                source: command.sourceInfo.path,
            })),
        tools: definitions(),
    };
}

function publishCatalogue(): void {
    const value = catalogue();
    const fingerprint = JSON.stringify(value);

    if (fingerprint !== catalogueFingerprint) {
        effect({ kind: "catalogue", catalogue: value });
        catalogueFingerprint = fingerprint;
    }
}

function allTools(): ToolInfo[] {
    return [...snapshot.nativeTools, ...definitions()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as TSchema,
        exposure: tool.exposure,
        ...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
        sourceInfo: createSyntheticSourceInfo(tool.source, { source: "pocket" }),
    }));
}

function runtime(): ExtensionRunner {
    if (!runner) {
        throw new Error("Terminal extension host is not initialized");
    }

    return runner;
}

async function initialize(packet: Extract<ToHost, { type: "initialize" }>): Promise<void> {
    if (runner) {
        throw new Error("Terminal extension host is already initialized");
    }

    process.env.PI_CODING_AGENT_DIR = packet.agentDir;
    process.chdir(packet.cwd);
    refresh(packet.snapshot);
    const settings = SettingsManager.create(packet.cwd, packet.agentDir);

    settings.setProjectTrusted(packet.trusted);
    await settings.reload();
    // Resolve with a no-install callback BEFORE loading. This respects package manifests, filters,
    // and trust without downloading packages or modifying the owner's installation.
    const packages = new DefaultPackageManager({
        cwd: packet.cwd,
        agentDir: packet.agentDir,
        settingsManager: settings,
    });
    const paths = await packages.resolve(async () => "error");
    // Loose global plugins often depend on terminal-only input/editor APIs. Keep them out of
    // Pocket without changing Pi's settings; installed packages and project trust still apply.
    const globalExtensions = join(packet.agentDir, "extensions");
    const enabled = paths.extensions.filter((source) => {
        const local = relative(globalExtensions, source.path);
        const globalLoose =
            local === "" || (local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local));

        return source.enabled && !source.path.startsWith("builtin:") && !globalLoose;
    });
    const loader = new DefaultResourceLoader({
        cwd: packet.cwd,
        agentDir: packet.agentDir,
        settingsManager: SettingsManager.inMemory({}),
        noExtensions: true,
        additionalExtensionPaths: enabled.map((source) => source.path),
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
    });

    await loader.reload();
    const loaded = loader.getExtensions();

    for (const extension of loaded.extensions) {
        if (extension.shortcuts.size > 0) {
            unsupported(
                `terminal shortcuts ${[...extension.shortcuts.keys()].join(", ")} registered by ${extension.path}`,
            );
        }

        extension.shortcuts.set = () =>
            unsupported(`terminal shortcuts registered by ${extension.path}`);

        for (const [type, handlers] of extension.handlers) {
            if (handlers.length > 0) {
                requireMappedEvent(type, extension.path);
            }
        }

        const set = extension.handlers.set.bind(extension.handlers);

        // SDK pi.on() resolves this map dynamically, including registrations made by commands/tools.
        // The runtime API entrance below checks operation ownership before a list can be mutated.
        extension.handlers.set = (type, handlers) => {
            requireMappedEvent(type, extension.path);

            return set(type, handlers);
        };
    }

    const assertLoadedActive = loaded.runtime.assertActive;

    // Guard at the SDK API entrance as well as each stateful action: registerTool/Command mutate
    // their SDK registries BEFORE invoking refreshTools, so guarding the latter alone is too late.
    loaded.runtime.assertActive = () => {
        assertLoadedActive();
        operation();
    };

    if (loaded.runtime.mcpServers.list().length > 0) {
        unsupported("extension-registered MCP servers");
    }

    const models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
    });
    const modelRegistry = new ModelRegistry(models);
    const blockedRegistry = new Proxy(modelRegistry, {
        get(target, key) {
            if (
                [
                    "stream",
                    "streamSimple",
                    "complete",
                    "classify",
                    "generateImages",
                    "getApiKeyAndHeaders",
                    "getApiKeyForProvider",
                    "getProviderAuth",
                    "refresh",
                    "registerProvider",
                    "registerVirtualModel",
                    "unregisterProvider",
                    "unregisterVirtualModel",
                ].includes(String(key))
            ) {
                return () => unsupported(`modelRegistry.${String(key)}`);
            }

            const value = Reflect.get(target, key, target);

            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    // All contexts retain one live session facade, even after Pocket refreshes the projection.
    const session = new Proxy(view, {
        get(_target, key) {
            if (key === "buildSessionProjection") {
                return projection;
            }

            if (key === "buildContextEntries") {
                return () => projection().entries.map((item) => item.sourceEntry);
            }

            if (key === "getEntry") {
                return (id: string) => view.getEntry(snapshot.aliases?.[id] ?? id);
            }

            if (key === "getLabel") {
                return (id: string) => view.getLabel(snapshot.aliases?.[id] ?? id);
            }

            const value = Reflect.get(view, key, view);

            return typeof value === "function" ? value.bind(view) : value;
        },
    });

    runner = new ExtensionRunner(
        loaded.extensions,
        loaded.runtime,
        packet.cwd,
        session,
        blockedRegistry,
    );
    runner.onError((error) => {
        const current = operations.getStore();

        if (current) {
            current.errors.push(`${error.event}: ${error.error}`);
        } else {
            fail("runtime", new Error(error.error));
        }
    });
    active = [
        ...new Set([
            ...snapshot.activeTools,
            ...definitions()
                .filter((tool) => tool.exposure === "direct" || tool.exposure === "model-only")
                .map((tool) => tool.name),
        ]),
    ];
    knownTools = new Set(definitions().map((tool) => tool.name));
    const actions: ExtensionActions = {
        appendEntry(customType, data) {
            operation();
            const id = view.appendCustomEntry(customType, data);

            effect({ kind: "entry", entry: entry(id), after: anchor() });
        },
        sendMessage(message, options) {
            operation();
            const id = view.appendCustomMessageEntry(
                message.customType,
                message.content,
                message.display,
                message.details,
            );

            effect({
                kind: "message",
                custom: messageEntry(id),
                after: anchor(),
                content: message.content,
                trigger: options?.triggerTurn ?? false,
                delivery: options?.deliverAs ?? "nextTurn",
                expand: false,
            });
        },
        sendUserMessage(content, options) {
            effect({
                kind: "message",
                content,
                after: anchor(),
                trigger: true,
                delivery: options?.deliverAs ?? "followUp",
                expand: options?.expandPromptTemplates ?? false,
            });
        },
        getActiveTools: () => [...active],
        setActiveTools(names) {
            operation();
            const known = new Set(
                allTools()
                    .filter((tool) => tool.exposure !== "hidden")
                    .map((tool) => tool.name),
            );

            active = [...new Set(names.filter((name) => known.has(name)))];
            effect({ kind: "tools", names: active });
        },
        getAllTools: allTools,
        getCommands: () =>
            runtime()
                .getRegisteredCommands()
                .map((command) => ({
                    name: command.invocationName,
                    description: command.description,
                    source: "extension",
                    sourceInfo: command.sourceInfo,
                })),
        getSettings: () => settings.getSettings(),
        refreshTools: () => {
            operation();
            const tools = definitions();

            for (const tool of tools) {
                if (
                    !knownTools.has(tool.name) &&
                    (tool.exposure === "direct" || tool.exposure === "model-only")
                ) {
                    active.push(tool.name);
                }

                if (tool.exposure === "hidden") {
                    active = active.filter((name) => name !== tool.name);
                }
            }

            knownTools = new Set(tools.map((tool) => tool.name));
            publishCatalogue();
            effect({ kind: "tools", names: active });
        },
        getSessionName: () => view.getSessionName(),
        setSessionName: () => unsupported("setSessionName"),
        setLabel: () => unsupported("setLabel"),
        setModel: () => unsupported("setModel"),
        getThinkingLevel: () => snapshot.thinkingLevel,
        setThinkingLevel: () => unsupported("setThinkingLevel"),
    };
    const contextActions: ExtensionContextActions = {
        getModel: () => snapshot.model,
        getScopedModels: () => [],
        isIdle: () => !snapshot.busy,
        isProjectTrusted: () => packet.trusted,
        getSignal: () => operations.getStore()?.controller.signal,
        abort: () => effect({ kind: "abort" }),
        hasPendingMessages: () =>
            snapshot.pending ||
            log.some((item) => item.effect.kind === "message" && item.effect.trigger),
        shutdown: () => unsupported("shutdown"),
        getContextUsage: () => undefined,
        compact: () => unsupported("compact"),
        getSystemPrompt: () => snapshot.systemPrompt,
    };

    runner.bindCore(actions, contextActions, {
        registerProvider: () => unsupported("registerProvider"),
        registerNativeProvider: () => unsupported("registerNativeProvider"),
        unregisterProvider: () => unsupported("unregisterProvider"),
        registerVirtualModel: () => unsupported("registerVirtualModel"),
        unregisterVirtualModel: () => unsupported("unregisterVirtualModel"),
    });
    runner.bindCommandContext({
        waitForIdle: () => unsupported("waitForIdle"),
        newSession: () => unsupported("newSession"),
        fork: () => unsupported("fork from an extension command"),
        navigateTree: () => unsupported("navigateTree"),
        switchSession: () => unsupported("switchSession"),
        reload: () => unsupported("reload from an extension command; use Pocket's module reload"),
    });
    runner.setUIContext(
        {
            ...runner.getUIContext(),
            notify: (message, level = "info") => effect({ kind: "notify", message, level }),
            setStatus: (key, text) => effect({ kind: "status", key, text: text ?? null }),
            setWidget: (key, lines, options) => {
                if (lines !== undefined && !Array.isArray(lines)) {
                    unsupported("terminal widget components");
                }

                effect({
                    kind: "widget",
                    key,
                    lines: lines ?? null,
                    placement: options?.placement ?? "aboveEditor",
                });
            },
            confirm: async (title, message, options) =>
                (await ask({
                    kind: "confirm",
                    title,
                    message,
                    timeout: timeout(options?.timeout),
                })) === true,
            input: async (title, placeholder, options) => {
                const result = await ask({
                    kind: "input",
                    title,
                    message: placeholder,
                    timeout: timeout(options?.timeout),
                });

                return typeof result === "string" ? result : undefined;
            },
            select: async (title, options, dialogOptions) => {
                const result = await ask({
                    kind: "select",
                    title,
                    options,
                    timeout: timeout(dialogOptions?.timeout),
                });

                return typeof result === "string" && options.includes(result) ? result : undefined;
            },
            editor: async (title, prefill) => {
                const result = await ask({
                    kind: "editor",
                    title,
                    message: prefill,
                    timeout: timeout(),
                });

                return typeof result === "string" ? result : undefined;
            },
            setEditorText: (text) => effect({ kind: "editor", text }),
            pasteToEditor: (text) => effect({ kind: "editor", text }),
            getEditorText: () => unsupported("getEditorText"),
            custom: () => unsupported("custom terminal UI"),
            onTerminalInput: () => unsupported("onTerminalInput"),
            setFooter: () => unsupported("setFooter"),
            setHeader: () => unsupported("setHeader"),
            setTitle: () => unsupported("setTitle"),
            setEditorComponent: () => unsupported("setEditorComponent"),
            addAutocompleteProvider: () => unsupported("addAutocompleteProvider"),
            setToolsExpanded: () => unsupported("setToolsExpanded"),
            setWorkingMessage: () => unsupported("setWorkingMessage"),
            setWorkingVisible: () => unsupported("setWorkingVisible"),
            setWorkingIndicator: () => unsupported("setWorkingIndicator"),
            setHiddenThinkingLabel: () => unsupported("setHiddenThinkingLabel"),
        },
        "rpc",
    );
    send({
        type: "ready",
        id: packet.id,
        ...catalogue(),
        errors: (loaded.errors ?? []).map((error) => ({
            source: error.path,
            message: error.error,
        })),
    });
    catalogueFingerprint = JSON.stringify(catalogue());
}

async function event(value: Record<string, WireValue>): Promise<WireValue> {
    const type = value.type;

    if (typeof type !== "string") {
        throw new Error("Terminal extension event needs a type");
    }

    if (!SUPPORTED_EVENTS.has(type)) {
        return unsupported(`lifecycle event ${type}`);
    }

    // Event payloads are produced from Pocket's typed model/task messages by the parent adapter.
    // The wire boundary verifies JSON structure/size; SDK dispatch owns each handler's event contract.
    const event = value as unknown as ExtensionEvent;

    if (event.type === "turn_end" || event.type === "agent_before_settle") {
        const result = await runtime().emitBoundary(event, () => {
            const current = projection();

            return {
                contextEntries: current.entries,
                contextMessages: current.messages,
                llmMessages: convertToLlm(current.messages),
                pendingMessages: [],
                canContinue: !snapshot.pending,
            };
        });

        if (!result.valid) {
            throw new Error("Extension returned an invalid actionable boundary");
        }

        for (const draft of result.entries) {
            if (draft.type === "custom") {
                const id = view.appendCustomEntry(draft.customType, draft.data);

                effect({ kind: "entry", entry: entry(id), after: anchor() });
            } else if (draft.type === "custom_message") {
                const id = view.appendCustomMessageEntry(
                    draft.customType,
                    draft.content,
                    draft.display,
                    draft.details,
                );

                effect({
                    kind: "message",
                    content: draft.content,
                    custom: messageEntry(id),
                    after: anchor(),
                    trigger: false,
                    delivery: "nextTurn",
                    expand: false,
                });
            } else {
                unsupported(`boundary entry ${draft.type}`);
            }
        }

        if (result.continue) {
            effect({
                kind: "message",
                content: "Continue from the extension's actionable boundary.",
                after: anchor(),
                trigger: true,
                delivery: "followUp",
                expand: false,
            });
        }

        return null;
    }

    if (event.type === "tool_call") {
        return wireValue({ ...((await runtime().emitToolCall(event)) ?? {}), input: event.input });
    }

    if (event.type === "tool_result") {
        return wireValue((await runtime().emitToolResult(event)) ?? null);
    }

    if (event.type === "message_end") {
        const replacement = await runtime().emitMessageEnd(event);

        if (replacement) {
            unsupported("message_end replacements");
        }

        return null;
    }

    if (event.type === "agent_start" || event.type === "agent_end" || event.type === "turn_start") {
        await runtime().emit(event);

        return null;
    }

    return unsupported(`lifecycle event ${event.type}`);
}

async function invoke(value: HostOperation): Promise<WireValue> {
    switch (value.kind) {
        case "start":
            await runtime().emit({ type: "session_start", reason: value.reason });
            effect({ kind: "tools", names: active });

            return null;

        case "command": {
            const command = runtime().getCommand(value.name);

            if (!command) {
                throw new Error(`No enabled Pi extension command /${value.name}`);
            }

            await command.handler(value.args, runtime().createCommandContext());

            return null;
        }

        case "tool": {
            const tool: ToolDefinition | undefined = runtime().getToolDefinition(value.name);

            if (!tool || !active.includes(value.name)) {
                throw new Error(`Pi extension tool ${value.name} is not active`);
            }

            return wireValue(
                await tool.execute(
                    value.callId,
                    value.args,
                    operation().controller.signal,
                    undefined,
                    runtime().createToolContext(value.callId, operation().controller.signal),
                ),
            );
        }

        case "event":
            return event(value.event);
    }
}

function fail(id: string, error: unknown): void {
    if (closing) {
        return;
    }

    const message = error instanceof Error ? error.message : String(error);

    try {
        send({ type: "error", id, message });
    } finally {
        close();
    }
}

function close(): void {
    closing = true;
    requests.clear();
    runner?.invalidate("Pi Pocket extension host was disposed");

    for (const current of running.values()) {
        current.closed = true;
        current.controller.abort();
    }

    for (const dialog of dialogs.values()) {
        dialog.resolve(null);
    }

    // Trusted plugins may retain timers/resources; terminate this host rather than leave detached work.
    setImmediate(() => process.exit(0));
}

process.on("message", (value) => {
    let packet: ToHost | undefined;

    try {
        packet = requests.receive(value);
    } catch (error) {
        fail("protocol", error);

        return;
    }

    if (!packet) {
        return;
    }

    if (packet.type === "close") {
        close();
    } else if (packet.type === "ack") {
        if (packet.through > sequence) {
            fail("protocol", new Error("Acknowledgement exceeds extension effect sequence"));

            return;
        }

        log = log.filter((item) => item.seq > packet.through);
    } else if (packet.type === "answer") {
        dialogs.get(packet.id)?.resolve(packet.value);
    } else if (packet.type === "cancel") {
        running.get(packet.id)?.controller.abort();
    } else if (packet.type === "initialize") {
        void initialize(packet).catch((error) => fail(packet.id, error));
    } else {
        if (running.has(packet.id) || closing) {
            fail(packet.id, new Error("Duplicate or stale extension operation"));

            return;
        }

        const current: Operation = {
            id: packet.id,
            controller: new AbortController(),
            errors: [],
            closed: false,
        };

        running.set(packet.id, current);
        void operations.run(current, async () => {
            try {
                refresh(packet.snapshot);
                const result = await invoke(packet.operation);

                await Promise.resolve();

                if (current.errors.length > 0) {
                    throw new Error(current.errors.join("\n"));
                }

                operation();
                publishCatalogue();
                effect({ kind: "complete", result });
                current.closed = true;
                send({ type: "result", id: packet.id, log });
            } catch (error) {
                fail(packet.id, error);
            } finally {
                running.delete(packet.id);
            }
        });
    }
});
process.on("disconnect", close);
process.on("uncaughtException", (error) => fail("runtime", error));
process.on("unhandledRejection", (error) => fail("runtime", error));
