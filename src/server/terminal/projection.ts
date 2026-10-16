/** Disposable SDK history and exact active context, projected solely from authoritative Pocket state. */
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSystemMessageText, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import {
    CURRENT_SESSION_VERSION,
    type FileEntry,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
    InboxDoc,
    type ConversationId,
    type Cursor,
    type EntryRecord,
    type TaskId,
} from "@earendil-works/pi-durable";
import type { PocketApp } from "../app.ts";
import { TerminalStateDoc, TerminalWorkDoc } from "../docs.ts";
import { mergeSdkEntries, type AnchoredEntry } from "./entries.ts";
import { parseCustomEntry, parseHostSnapshot, wireValue, type HostSnapshot } from "./protocol.ts";

const context = BACKGROUND_CONTEXT;

export const TERMINAL_TOOLS_PREFIX = "pocket-terminal-tools-";

/** Provider answers use their task identity even before their final Durable row has been published. */
export function answerIdentity(task: TaskId | number): string {
    return `answer:${Number(task)}`;
}

function identity(entry: EntryRecord): string {
    const message = entry.model?.[0];

    return entry.kind === "pi.assistant" &&
        entry.byTaskId !== undefined &&
        message?.role === "assistant" &&
        message.stopReason !== "error" &&
        message.stopReason !== "aborted"
        ? answerIdentity(entry.byTaskId)
        : String(entry.id);
}

function nativeMessages(messages: readonly Message[]) {
    return messages.filter((message) => message.role !== "system");
}

export async function terminalSnapshot(
    app: PocketApp,
    id: ConversationId,
    pending?: { task: TaskId; message: AssistantMessage },
): Promise<HostSnapshot> {
    const conversation = await app.conversation(id);
    const [active, agent, state, inbox, work] = await Promise.all([
        conversation.context(context),
        conversation.agent(context),
        app.harness.snapshot(TerminalStateDoc, id, context),
        app.harness.snapshot(InboxDoc, id, context),
        app.harness.snapshot(TerminalWorkDoc, id, context),
    ]);
    const raw: EntryRecord[] = [];
    let cursor: Cursor | undefined;

    do {
        const page = await conversation.entries({ order: "ascending" }, 256, cursor, context);

        raw.push(...page.items);
        cursor = page.next;
    } while (cursor !== undefined);

    const visible = new Set(raw.map((entry) => Number(entry.id)));
    const mapped = new Map<number, SessionEntry>();
    const additional: AnchoredEntry[] = [];
    const bySource = new Map<number, SessionEntry[]>();
    const aliases: Record<string, string> = {};
    const placements = await app.harness.commit(async (tx) => {
        const values = new Map<string, number | undefined>();

        for (const item of state?.entries ?? []) {
            if (item.admission) {
                // The stored numeric owner is produced only from a native conversation id.
                const owner = item.admission.conversation as ConversationId;
                const submission = await tx.submissionByRequest(owner, item.admission.requestId);

                values.set(
                    item.admission.requestId,
                    submission?.entry === undefined ? undefined : Number(submission.entry),
                );
            }
        }

        return values;
    }, context);

    for (const item of state?.entries ?? []) {
        const sdk = parseCustomEntry(item.sdk);
        const placed = item.admission ? placements.get(item.admission.requestId) : undefined;

        if (item.admission && placed !== undefined && visible.has(placed)) {
            mapped.set(placed, sdk);
            // Keep admitted SDK identities in ledger order as positional fences for later entries.
            additional.push({ entry: sdk, after: item.after });
        } else if (!item.admission || item.admission.conversation === Number(id)) {
            // Source-session reads retain committed, not-yet-admitted custom metadata. A fork must
            // not inherit a custom message whose native admission lies outside its visible branch.
            additional.push({ entry: sdk, after: item.after });
        }
    }

    const hash = createHash("sha256").update(`${app.dataDir}:${id}`).digest("hex").slice(0, 32);
    const sessionId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
    const entries: FileEntry[] = [
        {
            type: "session",
            version: CURRENT_SESSION_VERSION,
            id: sessionId,
            timestamp: new Date(app.sessionMeta(id)?.createdAt ?? 0).toISOString(),
            cwd: app.cwdOf(id),
        },
    ];

    for (const row of raw) {
        const custom = mapped.get(Number(row.id));
        const sources: SessionEntry[] = [];

        if (custom) {
            entries.push(custom);
            sources.push(custom);
            aliases[String(row.id)] = custom.id;
        } else {
            const messages = nativeMessages(row.model ?? []);

            for (const [index, message] of messages.entries()) {
                const sdkId = index === 0 ? identity(row) : `${identity(row)}:${index}`;
                const sdk: SessionEntry = {
                    type: "message",
                    id: sdkId,
                    parentId: null,
                    timestamp: new Date(message.timestamp).toISOString(),
                    message,
                };

                entries.push(sdk);
                sources.push(sdk);
                aliases[index === 0 ? String(row.id) : `${row.id}:${index}`] = sdkId;
            }

            if (row.head !== undefined || row.edits !== undefined) {
                const sdk: SessionEntry = {
                    type: "custom",
                    id: `${row.id}:boundary`,
                    parentId: null,
                    timestamp: new Date(messages[0]?.timestamp ?? 0).toISOString(),
                    customType: "pocket-native-boundary",
                    data: wireValue({ kind: row.kind, head: row.head, edits: row.edits }),
                };

                entries.push(sdk);

                if (sources.length === 0) {
                    sources.push(sdk);
                    aliases[String(row.id)] = sdk.id;
                }
            }
        }

        bySource.set(Number(row.id), sources);
    }

    const projected: { sourceEntry: SessionEntry; messages: ReturnType<typeof nativeMessages> }[] =
        [];

    for (let index = 0; index < active.entries.length; index++) {
        const row = active.entries[index]!;
        const messages = nativeMessages(active.contributions[index] ?? []);
        const sourceEntry = bySource.get(Number(row.id))?.[0];

        if (sourceEntry) {
            projected.push({ sourceEntry, messages });
        }
    }

    const messages = nativeMessages(active.messages);

    if (pending && !entries.some((entry) => entry.id === answerIdentity(pending.task))) {
        const sdk: SessionEntry = {
            type: "message",
            id: answerIdentity(pending.task),
            parentId: null,
            timestamp: new Date(pending.message.timestamp).toISOString(),
            message: pending.message,
        };

        entries.push(sdk);
        projected.push({ sourceEntry: sdk, messages: [pending.message] });
        messages.push(pending.message);
    }

    const model = agent.model
        ? app.models.getModel(agent.model.provider, agent.model.modelId)
        : undefined;
    const native = new Map(
        agent.extensions
            .filter((extension) => !extension.name.startsWith(TERMINAL_TOOLS_PREFIX))
            .flatMap((extension) =>
                (extension.tools ?? []).map((tool) => [tool.name, tool] as const),
            ),
    );

    return parseHostSnapshot({
        entries: mergeSdkEntries(entries, additional),
        ...(additional.length > 0 ? { ledgerTail: additional.at(-1)!.entry.id } : {}),
        aliases,
        context: { entries: projected, messages },
        busy: app.isBusy(id),
        pending:
            (inbox?.items ?? []).some((item) => item.mode !== "write") ||
            Object.values(work?.outbox ?? {}).some(
                (intent) => intent.status === "pending" || intent.status === "blocked",
            ),
        nativeTools: [...native.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: wireValue(tool.parameters),
            source: `builtin:${tool.name}`,
            exposure: "direct",
        })),
        activeTools: agent.tools.map((tool) => tool.name),
        thinkingLevel: agent.thinkingLevel,
        systemPrompt: active.messages
            .filter((message) => message.role === "system")
            .map(getSystemMessageText)
            .join("\n"),
        ...(model
            ? {
                  model: {
                      id: model.id,
                      name: model.name,
                      api: model.api,
                      provider: model.provider,
                      baseUrl: model.baseUrl,
                      reasoning: model.reasoning,
                      input: model.input,
                      cost: {
                          input: model.cost.input,
                          output: model.cost.output,
                          cacheRead: model.cost.cacheRead,
                          cacheWrite: model.cost.cacheWrite,
                      },
                      contextWindow: model.contextWindow,
                      maxTokens: model.maxTokens,
                  },
              }
            : {}),
    });
}
