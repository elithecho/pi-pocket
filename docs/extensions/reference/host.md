# host

The host is the first argument of a module's default export. A module uses it to read from Pi Pocket and to report to it. To add to the app, a module uses [`web`](web.md), the second argument.

The host does not change when a module reloads. It changes only when the server restarts. Thus a module that uses a member newer than the running server must check that the member is there. [Using the host](../host.md) tells you how.

The types are `Host` and the types that it uses, in [types/pocket.d.ts](../../../types/pocket.d.ts). [Types for your editor](types.md) tells you how to import them.

## Folders

### `dataDir`

```ts
readonly dataDir: string;
```

Since 0.1.0 · Stable

Pi Pocket's data folder. It is `~/.pi-pocket`, unless `PI_POCKET_DIR` or the `--data` option gives another folder. The drop-in folder is `extensions/` in it.

### `agentDir`

```ts
readonly agentDir: string;
```

Since 0.1.0 · Stable

Pi's own folder, usually `~/.pi/agent`. Pi keeps its sign-ins, models, settings, skills, and prompt templates there.

## Skills

### `skillPaths`

```ts
skillPaths(): string[];
```

Since 0.1.0 · Stable

The extra skill folders that Pi's settings give.

### `skills`

```ts
skills(cwd: string): Skill[];
```

Since 0.12.0 · Stable

Pi's skills for a session that works in the folder `cwd`. The list has the skills from all the places where Pi looks.

## Models

### `resolveModel`

```ts
resolveModel(spec: string): ModelRef;
```

Since 0.1.0 · Stable

Finds a model from `provider/modelId`, or from a model id alone. The model must be signed in, and its sign-in must work. When there is no such model, it throws an error. The error names no other models: the choice of model is the person's.

### `subagentModels`

```ts
subagentModels(): readonly string[];
```

Since 0.13.1 · Stable

The models that the owner lets subagents use, as `provider/modelId`. A subagent can always use the model of its own session. The list is empty by default. The owner sets it in Menu → Providers → Models for subagents.

### `modelProblem`

```ts
modelProblem(ref: ModelRef, fresh?: boolean): Promise<string | undefined>;
```

Since 0.13.1 · Stable

Why Pi cannot use a model now, in words that Pi can tell a person. For example, Pi Pocket does not know the model, its provider is not signed in, or its sign-in expired. It is `undefined` when Pi can use the model. With `fresh: true`, it asks the provider about the sign-in again first.

### `thinkingLevels`

```ts
readonly thinkingLevels: readonly ModelThinkingLevel[];
```

Since 0.14.0 · Stable

The thinking levels, lowest first. They have the names that models and sessions use.

## People and limits

### `requesterOf`

```ts
requesterOf(conversationId: ConversationId): string | undefined;
```

Since 0.3.0 · Stable

The id of the person that Pi works for in a session now. This is the person whose message started Pi's current work.

### `heldBack`

```ts
heldBack(conversationId: ConversationId): string | undefined;
```

Since 0.12.0 · Stable

Why Pi cannot start work in a session now when nobody asked for it, for example to read a subagent's report. The reason is a spend limit: the session's limit, or the limit of the person who pays there. It is `undefined` when Pi can start.

### `onLimitsChanged`

```ts
onLimitsChanged(listener: () => void): () => void;
```

Since 0.12.0 · Stable

Calls `listener` each time the owner changes a spend limit. It returns a function: call it to stop.

## Notices and text

### `notice`

```ts
notice(level: NoticeLevel, message: string, conversationId?: ConversationId): void;
```

Since 0.1.0 · Stable

Reports something to the server's log and to the app. `level` is `"info"`, `"warning"`, or `"error"`. With `conversationId`, only the tabs of that session show the notice. Pi Pocket 0.13.1 added `conversationId`.

### `text`

```ts
readonly text: SafeText;
```

Since 0.14.0 · Stable

Makes text from other places safe for Pi to read: from a web page, an issue, or a file that a person did not write. In the same place, tell Pi that the text is data.

#### `text.quoted`

```ts
quoted(text: string, max?: number): string;
```

Since 0.14.0 · Stable

Gives the text as one line in quotes that the text cannot close. It removes invisible characters and tags, and it cuts the line to `max` characters. [Limits](limits.md#host) gives the default `max`.

#### `text.defang`

```ts
defang(text: string): string;
```

Since 0.14.0 · Stable

Keeps the lines of the text, but leaves no closing tag in it. Use it for text that you put between tags of your own.

## Independent linked chats (fork API)

### `linkedChats`

```ts
readonly linkedChats?: LinkedChats;
```

Since 0.14.0 · Experimental

This fork retains its own service, not upstream's incompatible linkedSessions API. Check that it exists before use. [Starting and messaging chats](../linked-sessions.md) describes permissions, replays and independent lifecycles.

#### `linkedChats.modelSelection`

```ts
readonly modelSelection?: true;
```

Since 0.14.0 · Experimental

True when startup route overrides are supported. Otherwise request a server restart.

#### `linkedChats.start`

```ts
start(
    source: ConversationId,
    request: { title: string; message: string; model?: string; thinking?: string },
    key: string,
): Promise<ConversationId>;
```

Since 0.14.0 · Experimental

Creates a chat and returns its conversation id, without delivering its first message. A nonempty title and task are required. Omitted model/thinking inherit once. A model-only override adjusts inherited thinking to a supported level. Explicit thinking is exact, with no source cap or subagent allowlist. Unavailable routes create nothing. Call `address`, then `send` separately; failed initial delivery leaves the existing chat available for retry.

#### `linkedChats.send`

```ts
send(
    source: ConversationId,
    target: number | string,
    message: string,
    steer: boolean,
    key: string,
): Promise<{ requestId: string }>;
```

Since 0.14.0 · Experimental

Use a source-local opaque handle in tools. True steers at the next pause; false queues. The `team` tool defaults to true, while this host method requires an explicit boolean. Returns on admission, not on an answer. Text is fenced and does not dispatch slash commands. Replays reuse the original submission.

#### `linkedChats.list`

```ts
list(source: ConversationId): Promise<LinkedChat[]>;
```

Since 0.14.0 · Experimental

Visible linked family at any distance. Metadata appears only when every source viewer can see that peer.

#### `linkedChats.address`

```ts
address(source: ConversationId, target: number): Promise<string>;
```

Since 0.14.0 · Experimental

Returns a stable source-local handle for a visible peer. Never expose internal conversation ids in shared tool output.

#### `LinkedChat`

```ts
interface LinkedChat {
    id: number;
    handle: string;
    title?: string;
    cwd?: string;
    busy?: boolean;
    archived?: boolean;
}
```

Since 0.14.0 · Experimental

A peer returned by list:

- `id`: internal numeric conversation id, for server-side use only.
- `handle`: source-local opaque address for tools and peer messages.
- `title`: optional title, only when every source viewer may see it.
- `cwd`: optional folder, under the same visibility condition.
- `busy`: optional working state, under the same visibility condition.
- `archived`: optional archive state, under the same visibility condition.

## Internal members

The host has more members, for Pi Pocket's built-in modules only. They are not in the types file, and they can change in any release without notice. Do not use them in a drop-in. [API stability](../policies/api-stability.md) tells you what this means.

- `approvals`: tool calls that wait for a person to allow them.
- `guard`: Lancet Guard.
- `schedules`: scheduled messages, for the schedule tool.
- `goals`: Done when, for the goals module.
- `browsers`: the built-in browser, for the browser tool.
- `memory`: the lessons that Pi keeps across sessions, for the memory tool.
- `watches`: the pull request watches of sessions, for the `watch_pr` tool.
- `repoWatches`: the task of repository watches, for the triggers module.
- `pip`: what the tools of PiP, the owner's assistant, do.
- `pipCompaction`: PiP's own summaries when its context is compacted.
- `gallery`: the extension gallery, for its own routes.
