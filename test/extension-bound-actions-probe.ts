/** Run: node test/extension-bound-actions-probe.ts /absolute/path/to/pi-goal/index.ts */
import { cleanUp, root, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
    convertToLlm,
    DefaultResourceLoader,
    ExtensionRunner,
    ModelRegistry,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type ExtensionActions,
    type ExtensionContextActions,
    type FileEntry,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText, InMemoryCredentialStore } from "@earendil-works/pi-ai";

const path = process.argv[2];

if (!path) {
    throw new Error("Pass the local pi-goal extension entry path; no packages will be installed.");
}

const models = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "binding-models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
});
const observations: string[] = [];

async function bind(entries?: FileEntry[]) {
    const loader = new DefaultResourceLoader({
        cwd: work,
        agentDir: process.env.PI_CODING_AGENT_DIR!,
        settingsManager: SettingsManager.inMemory({}),
        noExtensions: true,
        additionalExtensionPaths: [resolve(path!)],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
    });

    await loader.reload();
    const loaded = loader.getExtensions();

    assert.deepEqual(loaded.errors, []);
    const session = SessionManager.inMemory(work, undefined, entries);
    const runner = new ExtensionRunner(
        loaded.extensions,
        loaded.runtime,
        work,
        session,
        new ModelRegistry(models),
    );
    const messages: { content: unknown; trigger?: boolean }[] = [];
    const statuses = new Map<string, string | undefined>();
    const errors: string[] = [];
    let active = runner.getAllRegisteredTools().map((tool) => tool.definition.name);

    const unsupported = (): never => {
        throw new Error("Unsupported in isolated binding probe");
    };

    const actions: ExtensionActions = {
        appendEntry: (customType, data) => {
            session.appendCustomEntry(customType, data);
        },
        sendMessage: (message, options) => {
            session.appendCustomMessageEntry(
                message.customType,
                message.content,
                message.display,
                message.details,
            );
            messages.push({ content: message.content, trigger: options?.triggerTurn });
        },
        sendUserMessage: (content) => {
            messages.push({ content, trigger: true });
        },
        getActiveTools: () => active,
        setActiveTools: (names) => {
            active = [...names];
        },
        getAllTools: () => [],
        getCommands: () => [],
        getSettings: () => ({}),
        refreshTools: () => {},
        getSessionName: () => undefined,
        setSessionName: unsupported,
        setLabel: unsupported,
        setModel: unsupported,
        getThinkingLevel: () => "off",
        setThinkingLevel: unsupported,
    };
    const contextActions: ExtensionContextActions = {
        getModel: () => undefined,
        getScopedModels: () => [],
        isIdle: () => true,
        isProjectTrusted: () => false,
        getSignal: () => undefined,
        abort: unsupported,
        hasPendingMessages: () => false,
        shutdown: unsupported,
        getContextUsage: () => undefined,
        compact: unsupported,
        getSystemPrompt: () => "",
    };

    runner.onError((error) => errors.push(error.error));
    runner.bindCore(actions, contextActions);
    runner.setUIContext(
        {
            ...runner.getUIContext(),
            notify: (message) => observations.push(message),
            setStatus: (key, value) => statuses.set(key, value),
            confirm: async () => true,
        },
        "rpc",
    );

    const command = async (args: string) => {
        const registered = runner.getCommand("goal");

        assert.ok(registered);
        await registered.handler(args, runner.createCommandContext());
        await Promise.resolve();
        assert.deepEqual(errors, []);
    };

    const goal = () => {
        const entry = session
            .getBranch()
            .findLast((entry) => entry.type === "custom" && entry.customType === "pi-goal");

        assert.ok(entry?.type === "custom");
        const data = entry.data as {
            goal: { status: string; objective: string; tokensUsed: number };
        };

        return data.goal;
    };

    return { runner, session, messages, statuses, errors, active: () => active, command, goal };
}

try {
    const host = await bind();

    await host.runner.emit({ type: "session_start", reason: "new" });
    assert.deepEqual(host.active(), ["create_goal"]);
    await host.command("--tokens 100 binding probe objective");
    assert.equal(host.goal().status, "active");
    assert.deepEqual(host.active().sort(), ["create_goal", "get_goal", "update_goal"]);
    assert.equal(host.messages[0]?.trigger, true);
    assert.match(JSON.stringify(host.messages[0]?.content), /binding probe objective/);
    await host.command("pause");
    assert.equal(host.goal().status, "paused");
    assert.deepEqual(host.active(), ["create_goal"]);
    await host.command("resume");
    assert.equal(host.goal().status, "active");
    const get = host.runner.getToolDefinition("get_goal");

    assert.ok(get);
    const read = await get.execute(
        "get-probe",
        {},
        undefined,
        undefined,
        host.runner.createToolContext("get-probe", undefined),
    );

    assert.match(JSON.stringify(read.content), /binding probe objective/);
    await host.runner.emit({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
    const message = {
        ...fauxAssistantMessage([fauxText("probe answer")]),
        usage: {
            input: 12,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
    };

    await host.runner.emitBoundary(
        {
            type: "turn_end",
            turnIndex: 0,
            message,
            toolResults: [],
            messageEntryId: "probe-answer",
            toolResultEntryIds: [],
            outcome: "completed",
        },
        () => {
            const projection = host.session.buildSessionProjection();

            return {
                contextEntries: projection.entries,
                contextMessages: projection.messages,
                llmMessages: convertToLlm(projection.messages),
                pendingMessages: [],
                canContinue: true,
            };
        },
    );
    assert.equal(host.goal().tokensUsed, 15);
    const count = host.messages.length;

    await host.runner.emit({ type: "agent_end", messages: [] });
    await Promise.resolve();
    assert.equal(host.messages.length, count + 1);
    assert.equal(host.messages.at(-1)?.trigger, true);
    const stored: FileEntry[] = [host.session.getHeader()!, ...host.session.getEntries()];

    host.runner.invalidate();
    const resumed = await bind(stored);

    await resumed.runner.emit({ type: "session_start", reason: "resume" });
    assert.equal(resumed.goal().status, "active", "idle rehydration must not pause an active goal");
    await resumed.runner.emit({ type: "session_start", reason: "reload" });
    assert.equal(resumed.goal().status, "paused", "explicit reload/restart intentionally pauses");
    await resumed.command("resume");
    const update = resumed.runner.getToolDefinition("update_goal");

    assert.ok(update);
    await update.execute(
        "complete-probe",
        { status: "complete" },
        undefined,
        undefined,
        resumed.runner.createToolContext("complete-probe", undefined),
    );
    assert.equal(resumed.goal().status, "complete");
    const completedMessages = resumed.messages.length;

    await resumed.runner.emit({ type: "agent_end", messages: [] });
    await Promise.resolve();
    assert.equal(resumed.messages.length, completedMessages, "completion must stop continuation");
    assert.deepEqual(resumed.errors, []);
    resumed.runner.invalidate();
    console.log(
        "PASS: actual pi-goal bindCore set/pause/resume/read/update, continuation, 15-token accounting, resume vs reload restoration. No provider calls or persistent SDK sessions.",
    );
} finally {
    cleanUp();
}
