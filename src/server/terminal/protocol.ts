/** The bounded JSON protocol between Pocket and a memory-isolated extension host. */
import { Type, validateToolArguments, type Static, type TSchema } from "@earendil-works/pi-ai";

export const MAX_PACKET_BYTES = 8 * 1024 * 1024;
/** Full-history requests can span several bounded IPC frames. */
export const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
export const MAX_EFFECTS = 2000;
const Text = Type.String({ maxLength: MAX_PACKET_BYTES });
const Name = Type.String({ minLength: 1, maxLength: 512 });
const Json = Type.Cyclic(
    {
        Value: Type.Union([
            Type.Null(),
            Type.Boolean(),
            Type.Number(),
            Text,
            Type.Array(Type.Ref("Value")),
            Type.Record(Type.String(), Type.Ref("Value")),
        ]),
    },
    "Value",
);

export type WireValue = Static<typeof Json>;

const Entry = Type.Object(
    {
        type: Name,
        id: Name,
        timestamp: Text,
        parentId: Type.Optional(Type.Union([Text, Type.Null()])),
    },
    { additionalProperties: true },
);
const TextPart = Type.Object({ type: Type.Literal("text"), text: Text });
const ImagePart = Type.Object({ type: Type.Literal("image"), data: Text, mimeType: Text });
const Parts = Type.Array(Type.Union([TextPart, ImagePart]));
const Content = Type.Union([Text, Parts]);
const Usage = Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    totalTokens: Type.Number(),
    cost: Type.Object({
        input: Type.Number(),
        output: Type.Number(),
        cacheRead: Type.Number(),
        cacheWrite: Type.Number(),
        total: Type.Number(),
    }),
});
const Message = Type.Union([
    Type.Object({ role: Type.Literal("user"), content: Content, timestamp: Type.Number() }),
    Type.Object({
        role: Type.Literal("assistant"),
        content: Type.Array(
            Type.Union([
                TextPart,
                Type.Object({
                    type: Type.Literal("thinking"),
                    thinking: Text,
                    thinkingSignature: Type.Optional(Text),
                    redacted: Type.Optional(Type.Boolean()),
                }),
                Type.Object({
                    type: Type.Literal("toolCall"),
                    id: Text,
                    name: Text,
                    arguments: Type.Record(Type.String(), Json),
                    thoughtSignature: Type.Optional(Text),
                }),
            ]),
        ),
        api: Text,
        provider: Text,
        model: Text,
        usage: Usage,
        timestamp: Type.Number(),
        stopReason: Type.Union(
            ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].map((value) =>
                Type.Literal(value),
            ),
        ),
    }),
    Type.Object({
        role: Type.Literal("toolResult"),
        toolCallId: Text,
        toolName: Text,
        content: Parts,
        details: Type.Optional(Json),
        isError: Type.Boolean(),
        timestamp: Type.Number(),
    }),
]);
const ToolResult = Type.Object({
    content: Parts,
    details: Type.Optional(Json),
    isError: Type.Optional(Type.Boolean()),
    usage: Type.Optional(Usage),
    terminate: Type.Optional(Type.Boolean()),
});
const ToolDecision = Type.Object({
    input: Type.Record(Type.String(), Json),
    block: Type.Optional(Type.Boolean()),
    reason: Type.Optional(Text),
});
const CustomEntry = Type.Object({
    type: Type.Literal("custom"),
    id: Name,
    timestamp: Text,
    parentId: Type.Union([Text, Type.Null()]),
    customType: Name,
    data: Type.Optional(Json),
});
const CustomMessage = Type.Object({
    type: Type.Literal("custom_message"),
    id: Name,
    timestamp: Text,
    parentId: Type.Union([Text, Type.Null()]),
    customType: Name,
    content: Content,
    display: Type.Boolean(),
    details: Type.Optional(Json),
});
const Custom = Type.Union([CustomEntry, CustomMessage]);

export type HostCustomEntry = Static<typeof Custom>;
export type HostContent = Static<typeof Content>;

const Tool = Type.Object({
    name: Name,
    description: Text,
    parameters: Type.Record(Type.String(), Json),
    source: Text,
    exposure: Type.Union([
        Type.Literal("direct"),
        Type.Literal("model-only"),
        Type.Literal("codemode"),
        Type.Literal("deferred"),
        Type.Literal("hidden"),
    ]),
    promptGuidelines: Type.Optional(Type.Array(Text)),
});
const Command = Type.Object({ name: Name, description: Text, source: Text });
const Catalogue = Type.Object({ commands: Type.Array(Command), tools: Type.Array(Tool) });
const Snapshot = Type.Object({
    entries: Type.Array(Entry),
    ledgerTail: Type.Optional(Text),
    aliases: Type.Optional(Type.Record(Type.String(), Text)),
    context: Type.Optional(
        Type.Object({
            entries: Type.Array(Type.Object({ sourceEntry: Entry, messages: Type.Array(Message) })),
            messages: Type.Array(Message),
        }),
    ),
    busy: Type.Boolean(),
    pending: Type.Boolean(),
    nativeTools: Type.Array(Tool),
    activeTools: Type.Array(Name),
    model: Type.Optional(
        Type.Object({
            id: Text,
            name: Text,
            api: Text,
            provider: Text,
            baseUrl: Text,
            reasoning: Type.Boolean(),
            input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
            cost: Type.Object({
                input: Type.Number(),
                output: Type.Number(),
                cacheRead: Type.Number(),
                cacheWrite: Type.Number(),
            }),
            contextWindow: Type.Number(),
            maxTokens: Type.Number(),
        }),
    ),
    thinkingLevel: Type.Union([
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
    ]),
    systemPrompt: Text,
});

export type HostSnapshot = Static<typeof Snapshot>;
export type HostTool = Static<typeof Tool>;

const Dialog = Type.Object({
    kind: Type.Union([
        Type.Literal("confirm"),
        Type.Literal("input"),
        Type.Literal("select"),
        Type.Literal("editor"),
    ]),
    title: Text,
    message: Type.Optional(Text),
    options: Type.Optional(Type.Array(Text)),
    timeout: Type.Integer({ minimum: 1, maximum: 600_000 }),
    expiresAt: Type.Optional(Type.Integer({ minimum: 0 })),
});

export type HostDialog = Static<typeof Dialog>;

const Effect = Type.Union([
    Type.Object({
        kind: Type.Literal("entry"),
        entry: Custom,
        after: Type.Union([Text, Type.Null()]),
    }),
    Type.Object({
        kind: Type.Literal("message"),
        content: Content,
        custom: Type.Optional(CustomMessage),
        after: Type.Union([Text, Type.Null()]),
        trigger: Type.Boolean(),
        delivery: Type.Union([
            Type.Literal("steer"),
            Type.Literal("followUp"),
            Type.Literal("nextTurn"),
        ]),
        expand: Type.Boolean(),
    }),
    Type.Object({ kind: Type.Literal("tools"), names: Type.Array(Name) }),
    Type.Object({ kind: Type.Literal("catalogue"), catalogue: Catalogue }),
    Type.Object({
        kind: Type.Literal("notify"),
        message: Text,
        level: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
    }),
    Type.Object({ kind: Type.Literal("status"), key: Name, text: Type.Union([Text, Type.Null()]) }),
    Type.Object({
        kind: Type.Literal("widget"),
        key: Name,
        lines: Type.Union([Type.Array(Text), Type.Null()]),
        placement: Type.Union([Type.Literal("aboveEditor"), Type.Literal("belowEditor")]),
    }),
    Type.Object({ kind: Type.Literal("editor"), text: Text }),
    Type.Object({ kind: Type.Literal("abort") }),
    Type.Object({ kind: Type.Literal("complete"), result: Json }),
]);

export type HostEffect = Static<typeof Effect>;

const LogEntry = Type.Object({
    seq: Type.Integer({ minimum: 1 }),
    operation: Name,
    effect: Effect,
});

export type HostLogEntry = Static<typeof LogEntry>;

const Operation = Type.Union([
    Type.Object({
        kind: Type.Literal("start"),
        reason: Type.Union([
            Type.Literal("new"),
            Type.Literal("fork"),
            Type.Literal("resume"),
            Type.Literal("reload"),
        ]),
    }),
    Type.Object({ kind: Type.Literal("command"), name: Name, args: Text }),
    Type.Object({ kind: Type.Literal("tool"), name: Name, callId: Name, args: Json }),
    Type.Object({ kind: Type.Literal("event"), event: Type.Record(Type.String(), Json) }),
]);

export type HostOperation = Static<typeof Operation>;

const ToHost = Type.Union([
    Type.Object({
        type: Type.Literal("initialize"),
        id: Name,
        cwd: Text,
        agentDir: Text,
        trusted: Type.Boolean(),
        snapshot: Snapshot,
    }),
    Type.Object({
        type: Type.Literal("invoke"),
        id: Name,
        operation: Operation,
        snapshot: Snapshot,
    }),
    Type.Object({ type: Type.Literal("ack"), through: Type.Integer({ minimum: 0 }) }),
    Type.Object({ type: Type.Literal("cancel"), id: Name }),
    Type.Object({
        type: Type.Literal("answer"),
        id: Name,
        value: Type.Union([Text, Type.Boolean(), Type.Null()]),
    }),
    Type.Object({ type: Type.Literal("close") }),
]);

export type ToHost = Static<typeof ToHost>;

const FromHost = Type.Union([
    Type.Object({
        type: Type.Literal("ready"),
        id: Name,
        commands: Type.Array(Command),
        tools: Type.Array(Tool),
        errors: Type.Array(Type.Object({ source: Text, message: Text })),
    }),
    Type.Object({
        type: Type.Literal("result"),
        id: Name,
        log: Type.Array(LogEntry, { maxItems: MAX_EFFECTS }),
    }),
    Type.Object({ type: Type.Literal("error"), id: Name, message: Text }),
    Type.Object({ type: Type.Literal("dialog"), id: Name, operation: Name, dialog: Dialog }),
]);

export type FromHost = Static<typeof FromHost>;
export type HostReady = Extract<FromHost, { type: "ready" }>;

/** JSON coercion is deliberate only here: symbols in TypeBox schemas and optional undefined fields are omitted. */
export function wireValue(value: unknown): WireValue {
    return jsonValue(value, MAX_PACKET_BYTES);
}

function jsonValue(value: unknown, maxBytes: number): WireValue {
    const text = JSON.stringify(value);

    if (text === undefined || Buffer.byteLength(text) > maxBytes) {
        throw new Error(
            maxBytes === MAX_REQUEST_BYTES
                ? "Terminal extension request exceeds the 64 MiB JSON protocol limit"
                : "Terminal extension packet exceeds the JSON protocol limit",
        );
    }

    return JSON.parse(text) as WireValue;
}

function parse<T extends TSchema>(
    schema: T,
    value: unknown,
    maxBytes = MAX_PACKET_BYTES,
): Static<T> {
    const json = jsonValue(value, maxBytes);

    if (json === null || typeof json !== "object" || Array.isArray(json)) {
        throw new Error("Terminal extension protocol requires an object packet");
    }

    // This SDK validator checks the authoritative TypeBox schema at the IPC boundary. Its public
    // return type is any, so the refinement is confined to this single validated boundary.
    return validateToolArguments(
        { name: "terminal-protocol", description: "Internal IPC packet", parameters: schema },
        { type: "toolCall", id: "packet", name: "terminal-protocol", arguments: json },
    ) as Static<T>;
}

export const parseHostToolResult = (value: unknown): Static<typeof ToolResult> =>
    parse(ToolResult, value);
export const parseHostToolDecision = (value: unknown): Static<typeof ToolDecision> =>
    parse(ToolDecision, value);
export const parseHostSnapshot = (value: unknown): HostSnapshot =>
    parse(Snapshot, value, MAX_REQUEST_BYTES);
export const parseCustomEntry = (value: unknown): HostCustomEntry => parse(Custom, value);
export const parseHostEffect = (value: unknown): HostEffect => parse(Effect, value);

/** Logical request validation; transport.ts separately enforces the limit on EVERY wire frame. */
export function parseToHost(value: unknown): ToHost {
    const request =
        value !== null &&
        typeof value === "object" &&
        "type" in value &&
        (value.type === "initialize" || value.type === "invoke");
    const packet = parse(ToHost, value, request ? MAX_REQUEST_BYTES : MAX_PACKET_BYTES);

    if (packet.type === "initialize" || packet.type === "invoke") {
        // Bound the complete non-snapshot envelope, including recursive tool/event arguments.
        // Replacing null with the snapshot then costs at most snapshotBytes + MAX_PACKET_BYTES.
        wireValue({ ...packet, snapshot: null });
    }

    return packet;
}

export const parseFromHost = (value: unknown): FromHost => parse(FromHost, value);
