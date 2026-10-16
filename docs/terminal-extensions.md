# Terminal extensions

Terminal extensions bridge configured Pi plugins into Pocket. This is different from a native
[Pocket drop-in](extensions.md): a terminal plugin receives Pi's extension API, not `PocketHost`.
Pocket still owns model requests, tools, permissions, spend, history and recovery. There is no second
agent loop or persistent Pi session file.

**Implementation status:** feature acceptance independently verified in the uncommitted feature
worktree; not deployed. Direct backend and desktop/mobile browser acceptance covers the supported
bridge and actual installed pi-goal package. Focused checks pass; the full suite retains four
independently reproduced baseline failures. Review dispositions, exact test results and the remaining
global-suite limitations are in [the evidence checkpoint](plans/extension-command-bridge-progress.md),
against [the implementation plan](plans/extension-host-implementation.md). The live server does not
automatically contain these changes: integration and a normal owner-controlled restart are separate.

## Enable and use

1. Install/configure the plugin in Pi on this host using the normal Pi settings and package filters.
   Pocket does not install missing packages and does not inherit ephemeral terminal `-e` arguments.
2. The owner opens Menu → **Extensions** and enables **Terminal extensions**. It is off by default.
   Read the warning: plugins have the server owner's OS privileges, including files, commands and
   network access. Separate child processes isolate JavaScript globals, **not permissions**.
3. In a session, type `/`. Plugin suggestions include **Pi extension** and source provenance.
   Choosing one fills the editor; press Send to execute it. Arguments retain their whitespace.
4. Native commands keep their short names. `/ext:<plugin-command>` always addresses the plugin;
   for example `/ext:model` cannot change Pocket's selected model through its native `/model` command.
   `/goal` is an ordinary discovered command when pi-goal is configured, not built into Pocket.
   A prompt template whose real name starts with `ext:` is offered as `/template:ext:…` while the
   bridge is on, keeping the plugin namespace unambiguous. If that escaped name is already another
   template, another `template:` prefix is added until the name is free. Both remain usable.

Project code is filtered by the owner's Pi project-trust decision before import. Disabled resources
must not run. PiP's restricted tool selection does not load terminal plugins. Viewers can read
status/widgets but cannot execute commands or answer dialogs. In take-turns sessions, the current
requester must also have driver rights.

## Portable UI

Notifications, named statuses and plain-text widgets render in Pocket. Widgets can sit above or
below the editor. Confirm, input, select and editor requests appear as forms for the requesting
person only. Answers are checked on the server for conversation, requester and current authority.
Cancel, timeout, loss of authority, browser disconnect/reload and host disposal dismiss pending
requests safely. Terminal rendering functions never execute in the browser.

Commands can run while the model or a plugin tool waits, so a plugin's pause command is not placed
behind the work it controls. A failed or lost HTTP reply can be retried with the same request ID;
completed results are read back rather than executing arbitrary plugin code again. The browser keeps
unresolved request IDs per person/conversation/command/args in tab storage across edits and reloads,
removing one only after a successful response. At 64 unresolved requests it refuses new commands
rather than dropping identities; a tab-storage failure also prevents dispatch. An interrupted
handler is reported as interrupted and is not replayed. It may already have changed external files.

## Reload, restart and rollback

Use **Reload** on Terminal extensions after changing Pi configuration or plugin code. Explicit reload
and server restart reconstruct the host with `session_start(reason: "reload")`. A plugin can use this
to pause restored work: actual pi-goal tests verify active goals become paused before interrupted
native work resumes. Idle rehydration uses `resume`, not `reload`; it must not spuriously pause work.

Turning the module off closes hosts and cancels pending plugin work/dialogs. Native conversation
history and stored extension metadata remain; disabling is the rollback, not deleting stored data.
Do not restart the live server while a coding tool call is running. Finish checks, then have the
owner restart normally.

## Compatibility boundary

The current bridge covers registered commands/tools, custom entries/messages, active tool selection,
portable UI and the Pocket lifecycle adapter. Native guard/plan and admission policy stay in force.
Unsupported actions throw diagnostics instead of invoking another model or bypassing Pocket policy:

- provider/auth/model-loop access and nested model/tool execution;
- session replacement/navigation, model/thinking/name/label mutation;
- plugin-driven compaction or unsupported boundary/context-edit contributions;
- custom terminal UI, headers/footers, editor components and terminal-input interception;
- detached effects outside a live bridge operation;
- terminal keyboard shortcuts (diagnosed at load and when registered later).

CLI flag registration/defaults remain readable through `getFlag`; Pocket does not forward terminal
CLI overrides or provide a flag editor. Message/entry/tool renderer and Markdown-transformer
registrations are intentionally not browser renderers: their callbacks are never run. Displayed
custom messages use a labeled generic plain-text row (with image thumbnails), including in exports;
`display: false` stays out of transcript/export while retaining its native model contribution.
Custom state entries are stored for the plugin, not rendered as arbitrary terminal components.
Passive writes require normal access/driver rights but do not require a model or unspent budget:
they cannot start model work. Triggering messages must still pass those native admission checks.

This is not full terminal-event parity. Supported registrations are `session_start`, `agent_start`,
`turn_start`, `message_end`, `tool_call`, `tool_result`, `turn_end`, `agent_end` and
`agent_before_settle`. Registering any other event fails explicitly with event/source provenance,
including registration from a command or tool. This includes `context`, `message_start`,
`agent_settled`, `session_shutdown` and streaming tool-execution events: Pocket does not pretend those
callbacks ran. A `message_end` replacement is also unsupported; observing finalized responses works,
including distinct failed/successful provider attempts in the same generation.

## Code and checks

`src/server/terminal/manager.ts` connects the process bridge to Pocket. `worker.ts` hosts the SDK;
`host.ts` owns IPC and child teardown; `protocol.ts` validates bounded packets. `projection.ts` and
`entries.ts` construct the branch-aware SDK view. `store.ts` atomically commits sequenced prefixes,
operation receipts and outbox intents. Only extension-owned metadata is stored separately from
ordinary Pocket history. Model-visible messages use normal attributed admission.

Hermetic regression suites (temporary settings/data; scripted provider only):

```sh
node --test test/terminal-host.test.ts test/terminal-store.test.ts \
  test/terminal-durability.test.ts test/terminal.test.ts test/terminal-ui.test.ts
```

The actual installed package is intentionally separate from the default suite:

```sh
PI_POCKET_GOAL_EXTENSION=/absolute/path/to/pi-goal/index.ts \
  node --test test/terminal-goal-acceptance.ts test/terminal-goal-ui-acceptance.ts
```

The latter covers actual start/continuation/tool completion, busy pause/resume, token-limit wrap-up,
paused restart, active reload and active restart without paid provider calls. It also checks pending
user-work priority, spend-blocked continuation and stop suppression. The separate browser acceptance
requires Chromium (it fails rather than silently skipping) and exercises the actual package through
desktop/mobile suggestions, the composer, busy pause, replacement confirmation, reconnect, resume,
continuation, completion and token budget. Tests read the plugin but never modify its installed files
or the owner's Pi settings.
