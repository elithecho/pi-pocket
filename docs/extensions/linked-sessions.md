# Starting and messaging chats in this fork

Agent Teams uses `host.linkedChats`, not upstream's incompatible `host.linkedSessions`. See the [host reference](reference/host.md#linkedchats) and [terminal extensions](../terminal-extensions.md). This capability is experimental.

## Independent chats

A linked chat is an ordinary sidebar session. It initially shares the source folder, but no worktree is created. Agent settings are copied once, not history, plan mode, budget, or terminal-plugin state. Each chat has independent settings, budgets and lifecycle. A link grants no access and no cancellation authority.

## Start and deliver

Check `host.linkedChats?.modelSelection === true` before using startup route overrides; otherwise ask for a server restart.

`start(source, { title, message, model?, thinking? }, key)` creates the chat and returns its conversation id. A nonempty title and task are required. Omitted model and thinking inherit once. A model-only override adjusts inherited thinking to a supported level at or below it, or the lowest supported level if none is lower. Explicit thinking must be supported exactly and is not capped to the source. Models do not use the nested-subagent allowlist. An unavailable route creates nothing and never falls back.

Creation does not deliver the task. Call `address(source, target)` to obtain its local handle, then `send(source, target, message, false, key)` for initial delivery. If delivery fails, keep the existing peer and retry its address, rather than starting a replacement.

## Send and list

`send(source, target, message, steer, key)` accepts an internal numeric target or an opaque source-local address. Tools must use opaque addresses, never expose numeric ids in shared output. `steer: true` delivers at the next pause, `false` queues a follow-up. The `team` tool defaults to true; the host requires an explicit boolean. Sending returns when accepted, not when answered; final answers are not automatically forwarded.

Peer text is fenced, attributed as sent for the requester and never dispatched as a slash command. Agents explicitly send meaningful results and questions; avoid polling, empty acknowledgments and reply loops.

`list(source)` returns visible linked peers with `id` and `handle`. Title, folder, working and archive state are present only when every source viewer may see that peer. `address(source, target)` gives the stable source-local handle. A fork starts with no peer addresses.

## Permissions and budgets

Starts and sends act as the source requester and retain access, driver, plan, model, terminal preparation and per-chat/person spend checks. Target checks apply to sends too. Viewers and session-scoped guests cannot start chats. Chats may start other peers; this fork imposes no upstream one-level, session-count, relay or source-thinking cap. Peer spending does not consume the originating chat's budget or appear as its spend; each chat's own budget still gates it.

## Replays and stored state

Use stable call keys, such as `${api.taskId}:${api.callId}`. Existing `pocket.linked-chat-peers` addresses and `pocket.linked-chat-call` receipts survive restart. Replayed creation returns the original target before new route validation; replayed delivery returns the original submission. A refused initial message leaves a linked chat for retry. These document names, scopes and meanings remain unchanged.
