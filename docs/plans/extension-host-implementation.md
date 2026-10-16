# Process-isolated Pi extension bridge

Status: production design approved after two Critic rounds; implementation in progress.

**Latest session checkpoint:** [extension-command-bridge-progress.md](extension-command-bridge-progress.md).
The continuation checkpoint supersedes the browser/UI status in the
[previous handoff](extension-command-bridge-handoff.md) and historical checkpoints below. Generic
browser/composer integration now passes real desktop/mobile checks, actual pi-goal backend acceptance
covers active reload/restart, and branch/compaction/reset projection has production-worker evidence.
Lifecycle/policy audit and final integrated review/verification remain unfinished. All implementation
remains uncommitted in the feature worktree.

## Outcome

A Pi extension installed/configured on this host can add a working slash command to Pocket without
Pocket knowing its name. `/goal` is an acceptance case, never a production special case. Pi Durable
remains the conversation and execution engine. Each active conversation gets an isolated extension
host, not another agent loop or persistent SDK session.

## What changes / what stays the same

Changes: an owner-enabled **Terminal extensions** module; dynamic command discovery and dispatch;
portable extension UI; plugin tools and lifecycle hooks; durable plugin state and message intents;
explicit diagnostics for unsupported capabilities. Enabling the module grants configured extensions
the owner's OS-level privileges, as native drop-ins already have. A process boundary isolates memory,
not permissions. The switch is off by default and requires an explicit trust warning.

Unchanged: native commands, templates, skills, attachments, absolute-path input, native drop-ins,
`/until`, PiP's restricted extension selection, existing stored document kinds, user-chosen models,
access/driver/guard/plan policies, accounting, and Durable task/recovery semantics. No dependency or
live-server changes; all work remains in this worktree, uncommitted.

## User flows and UI

1. Owner enables Terminal extensions in the existing Extensions sheet after a warning that configured
   extension code has host privileges. No extension factory is executed while this is off.
2. Typing `/` fetches conversation commands. The SDK discovers global and trusted project packages,
   extensions, filters, and paths using its normal settings. Resolve trust before loading project code.
   Disabled resources in Pi's configuration must not execute. Load failures retain provenance and a
   usable Pocket app. Project trust is never implicitly granted by seeing a command.
3. Plugin commands appear beside native commands and templates, with plugin/source provenance. A
   qualified `/ext:<SDK invocation name>` is always available; `/name` is available when it does not
   collide with a native Pocket command, skill, or template. SDK duplicate names retain `name:1` etc.
   Native short names always win. To keep the reserved `ext:` namespace unambiguous, templates whose
   actual names start with `ext:` are offered as `template:ext:…` while the bridge is on; add another
   `template:` prefix until free if an actual template already occupies that escaped name. Plugin
   short names do not use the protected `template:` namespace. Both template and plugin remain usable.
   Command suggestions fill the editor rather than auto-execute an
   argumentless plugin command, because it can have side effects.
4. Sending a plugin command calls a dedicated conversation endpoint with raw name/args and a stable
   client request ID; the server rechecks access/driver status and current availability. A stale name
   reports an error instead of becoming ordinary model input. General submit also recognizes registered
   extension commands for CLI/API callers, but ordinary unknown paths remain ordinary messages.
5. Commands run during an active model turn. A waiting extension tool or confirmation must not put a
   pause command behind the task it needs to control. UI requests are scoped to the conversation and
   requesting person; authorized responses are checked server-side. Notifications, status, and text
   widgets render generically. Dialog dismissal, timeout, lost driver rights, browser disconnect,
   reload, disabling, and host exit cancel pending dialogs safely.
6. State follows the Pocket branch. Browser reconnect reads current UI state. An explicit extension
   reload or server restart reconstructs the SDK view and emits `session_start(reason: "reload")`;
   this intentionally lets pi-goal pause restored active work. Idle eviction is allowed only when no
   operation, run, outbox intent, or dialog is live; rehydration uses `reason: "resume"`, never reload,
   and must not pause stored active work. A newly created conversation uses `new`, a fork uses `fork`.
   Interrupted arbitrary handlers are not replayed. Queued committed Pocket message effects recover
   through an idempotent outbox. Test explicit reload, restart, and idle rehydration separately.
7. Owner can reload the module to pick up Pi configuration/code changes. Cwd/trust changes invalidate
   a host before further invocations. Disable closes hosts and cancels pending effects/dialogs.

```text
Extensions
  Terminal extensions [off]
  Loads your configured Pi plugins in isolated hosts with your OS rights.

/goal …                 Set, view, pause, resume… [Pi extension]
/ext:model …            Plugin command colliding with Pocket's /model

Above composer
  Pi extension · Goal paused
  Replace goal?  Current: … New: … [Cancel] [Replace]

Failure
  Extension command interrupted; it may have performed external work. Not replayed.
```

## Runtime contract

- One lazily spawned Node child process per conversation, no model loop or persistent SessionManager.
  It loads the SDK's DefaultResourceLoader and ExtensionRunner. Native IPC carries structured JSON;
  stdout/stderr are diagnostics only. Capture bounded stderr; reject malformed/oversized packets.
- Host lives while its conversation has work or tabs; bounded idle eviction invalidates the runtime
  and reconstructs later. Limit simultaneously alive hosts and refuse excess with an actionable
  retry error rather than unbounded spawning. Close on disable, cwd/trust/config reload, app shutdown,
  or unexpected exit. Escalate graceful termination to kill after a bounded deadline; await exit.
- Pocket supplies a disposable fork-aware SDK projection with stable entry IDs and applicable context
  edits/compaction/reset boundaries. It includes custom state even when absent from LLM context.
  The host has ONE shared live SessionManager view, as Pi does, so a command can see synchronous
  appends made by a pending tool. Pocket snapshot refresh merges committed entries with the host's
  unacknowledged entry suffix by stable SDK identity; it cannot erase another operation's live writes.
  No JSONL store is created.
- Use AsyncLocalStorage to attribute effects to the current operation across awaits and microtasks.
  Commands and tools can overlap as in Pi. Every effect enters ONE monotonically sequenced host log,
  tagged with operation/requester. Completion adds a result marker; the host returns the whole
  unacknowledged prefix through that marker. Pocket serializes prefix commits, persists state plus
  message intents together, records the highest committed host sequence, and acknowledges that exact
  prefix. Duplicate/overlapping replies cannot apply a prefix twice. Before acknowledging a command,
  any earlier append it observed (even from a pending tool) is therefore committed as a checkpoint.
  The still-pending tool is not marked successful merely because its earlier effects were checkpointed.
  Effects outside a live operation are unsupported and produce a visible host error, not lost writes.
- Loading and every operation return serializable command/tool descriptors, active selection, UI
  effects, stored entries, and message intents. Validate at the IPC boundary. Subscribe to the SDK
  runner's onError before any lifecycle dispatch: because emit catches handler exceptions, any error
  captured for an operation makes that operation fail even if emit resolves. Throwing/failed operations
  invalidate the entire host and all uncommitted overlapping operations; buffered suffix effects are
  discarded. Already acknowledged checkpoints remain durable and their originating incomplete
  operation is visibly interrupted/failed, never reported as successful or replayed. Reconstruct from
  committed data only. Test an append-then-throw lifecycle handler, including an overlapping command.
- Use real SDK command contexts/tool contexts and event dispatch. Portable UI is an adapter over the
  existing extension UI contract. Unsupported terminal components, provider/auth/model-loop access,
  session-file navigation/replacement, and event transformations without a safe Durable equivalent
  fail explicitly. Do not provide real credentials to the extension model registry as an alternate
  provider path. Approved extension code itself is trusted OS-level code, not sandboxed.

### Explicit SDK runtime binding

Call `ExtensionRunner.bindCore(actions, contextActions)` before session_start or commands/tools.
The earlier unbound-runtime error is expected without this call, not an unresolved package import.

| SDK action                                                        | Bridge behavior                                                                                                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| appendEntry                                                       | Append synchronously to the shared in-memory SDK view; log the exact custom entry with its stable SDK id.                                                |
| sendMessage                                                       | Append SDK custom metadata synchronously and log a custom-message effect with trigger/delivery options; include locally queued effects in pending state. |
| sendUserMessage                                                   | Log attributed user input with delivery/expansion flags, never call a model in the worker.                                                               |
| getActiveTools/setActiveTools                                     | Read/update the host loadout synchronously and log selection; validate registered names; parent applies before next request preparation.                 |
| getAllTools/getCommands/getSettings                               | Return native metadata supplied by Pocket plus actual registered plugin metadata and resolved commands/settings.                                         |
| refreshTools                                                      | Return refreshed registered descriptors/selection through the effect log.                                                                                |
| session name/label/model/thinking mutators                        | Fail explicitly in the first compatibility surface, rather than bypass user policy; add only with a tested parent policy adapter.                        |
| isIdle/hasPendingMessages/model/trust/signal                      | Pocket snapshot plus in-host pending effects and per-operation cancellation.                                                                             |
| abort                                                             | Request parent stop as a policy-checked effect; no worker agent loop.                                                                                    |
| compact/shutdown/session replacement/provider/nested model access | Explicit unsupported diagnostics in this release.                                                                                                        |

Subscribe to onError and bind real portable UI before any dispatch. Generic command errors propagate
from handler invocation; SDK-caught lifecycle errors are promoted to operation failure. Registered
tool execution uses the SDK definition and createToolContext with the operation's abort signal.
Before final production-design approval, run a separate isolated binding probe against the actual
local pi-goal package: set, pause, resume, create/read/update tools, continuation, usage/budget, and
session-start reasons. This probe need not implement persistence; it proves the proposed SDK action
binding and event interfaces before the production adapter relies on them.

## Durable state/effect contract

Add only NEW document/entry kinds:

- `pocket.terminal-state`: rewindable/asOf conversation state for active tool selection, portable
  status/widgets, and an append-only ledger of extension-owned SDK custom entries/messages. The
  ledger retains SDK identity, an ordinary-history anchor, and message admission correlation. It is
  NOT a second copy of ordinary Pocket conversation history or a JSONL store. Real native tests prove
  document commits after an earlier answer are excluded by asOf forks at that answer. Model-visible
  payloads use normal write/input admission, not raw transcript appends while busy.
- `pocket.terminal-work`: latest/initial conversation document for command/event operation records,
  outbox intents, and stop epoch. Forks begin with no pending operations or autonomous outbox work.
  Retain every incomplete operation until settled (64 active operations maximum). Keep at most 64
  settled operation results and 64 settled outbox payloads, each cache also capped at 2 MiB. Archive
  old full operation receipts in `pocket.terminal-receipt` (latest/initial per-key document family), so
  old command retries still return their original result/error and never re-run unsafe handlers.
  Native submission records preserve message deduplication after settled outbox payloads are pruned.
  Keep active host acknowledgements and 32 recent inactive ones; stale disposed-host replies may be
  rejected, never re-applied. Pending/blocked intents are limited to 256 and 8 MiB; overflow atomically
  rejects a prefix rather than dropping work. Drain at most 32 intents per call, pending before blocked,
  and let the manager schedule later pending batches. Cold receipts grow like ordinary durable history;
  the hot admission indexes and each drain remain bounded.
- Custom state/message entries have separate SDK metadata and model contributions. Triggering custom
  messages use one normal input submission; passive messages use one queued/native write submission
  (`pocket.terminal-message`) with their metadata. Neither path duplicates content via a raw append.
  Retain the mapping from admitted entries to the custom SDK message identity for projection; plain
  `sendUserMessage` stays an ordinary attributed user input. Inherited custom messages whose admitted
  native entry is outside a fork must not leak into that fork's SDK/model context.

Before executing a command/tool/event, durably mark an operation with an idempotent key and requesting
person. Completed retries return the recorded result. Finding a started operation without its host
means interrupted: report it and never repeat arbitrary plugin code. Framework lifecycle operations
use stable keys derived from generation/tool task and phase; retries do not re-account the same turn.

On success, commit the unacknowledged ordered prefix (custom entries, tool/UI selection changes,
result markers, and attributed outbox intents) in ONE Durable transaction. A prefix can checkpoint
partial effects of a pending overlapping operation, matching the SDK's shared read-your-writes view;
it does not assert that pending handler completed. Do not acknowledge command success before its
result marker is committed. An operation failing without a previous checkpoint leaves none of its
Pocket effects; a previously checkpointed prefix remains durably labelled as incomplete/interrupted.
Discard all uncommitted suffix effects on handler/commit failure, invalidate the entire host and its
pending requests, and rebuild only from committed data. Never roll back already acknowledged effects.
The outbox only admits intents from a successfully committed prefix, including its original requester.

Drain outbox through the SAME authorization/spend/attribution/admission policy used by Commands.submit,
with stable `p:<user>:<operation-effect key>` IDs. Do not call a second agent or bypass tools. Avoid
recursive slash dispatch for extension-generated content unless expansion was explicitly requested.
Recover after commit-before-admission and admission-before-delivery-mark without duplicate input.
An intent whose requester loses access/control, exceeds spend, or whose stop epoch is obsolete cannot
silently run; retain/report a blocked outcome or cancel as appropriate. Stop increments the epoch,
withdraws queued continuation work, and stops the run; an in-flight stale host reply cannot restart it.
Bound outbox draining and host effects; malformed state or unbounded plugin output must fail visibly.

Native registry holds per-conversation plugin-tool extensions, excluded from host defaults and added
only to that conversation's AgentDoc selection. On a fork, replace inherited parent bridge selection
with the fork's host selection while preserving all non-bridge selection edits. Never globally replace
native tools with plugin tools: reject native/tool collisions with provenance. Tool execution delegates
to the correct host and uses Durable's unsafe replay default, argument validation, tool hooks, and
cancellation. Active tool changes commit before the next request loadout is prepared. Disable/eviction
must not remove registry definitions needed by an already-running invocation; retain dispatch wrappers
that can rehydrate a host or return an interrupted error, without permitting disabled code to reload.

## Lifecycle mapping

- Ensure/restore hosts and dynamic tool registry before admitting user work and before Harness.resume.
  This avoids missing-tool recovery and changing a loadout after request preparation.
- Generation beforeRequest: once per generation task, emit turn_start; emit agent_start once per run
  (derive stable run identity from placed input submissions). Retries of a provider request are not a
  new turn. The actual current model and busy/pending input state come from Pocket.
- Generation afterResponse: emit finalized message notification. For toolUse, defer turn_end until
  afterTools provides committed assistant and results. For a final answer, onYield supplies turn_end
  then agent_end in order before the final boundary. Include real usage for budget accounting.
- Tool beforeTool/afterTool: bridge supported SDK tool_call/tool_result contracts, composing mutations
  or blocks with native guard/plan hooks. Do not bypass native hooks for nested calls; unsupported
  nested execution must report failure rather than invoking tools directly.
- Lifecycle-triggered messages use the attributed outbox. An agent_end continuation can be admitted
  as followUp before the final boundary, so Durable chooses one queued input normally. Respect pending
  user work and local effects in hasPendingMessages, and recheck stop epoch/spend before admission.
- On abort/error/host failure, cancel owned requests and emit only safely supported terminal
  notifications; never manufacture a successful turn completion or re-run an uncertain handler.
- For SDK actionable boundary entries/continue, use its boundary dispatcher with a current preview.
  Support custom entries/messages; reject unsupported context-edit/compaction requests explicitly
  until a correct positional translation is proven. No pretending unsupported event results succeeded.

## Acceptance and evidence

1. Generic fixture: discover from user/project settings and a local package manifest, obey filters,
   show/execute a new command with raw args, conflicts and stale names, and make exactly one model
   request only when the plugin requests it. No Pocket special-case name.
2. Security: import/factory marker exclusion while bridge off, source disabled, or project untrusted;
   reject viewer/non-driver invocation and unauthorized/cross-conversation dialog responses.
3. State: concurrent same-cwd hosts isolate module globals, custom state has read-your-writes and
   survives host/server reload, fork inherits only through its branch point, cwd/trust changes
   invalidate correctly; ordinary history/context edits/compaction remain truthful in SDK view.
4. Effects: combined state-plus-message success/failure; inject failures before commit, after commit
   before admission, and after admission before delivery mark. Assert a single model-visible message,
   correct requester and usage, no retry of uncertain arbitrary code, and stop-epoch suppression.
5. Tools/events: dynamic tools offered at next request, native collisions rejected, guard/plan hooks
   enforced, usage counted once, bounded lifecycle continuation, pause while a tool/model is busy,
   queued user messages and spend exhaustion prevent unwanted continuation.
6. UI: notification/status/text widgets, confirm/input/select/editor and cancellation; desktop/mobile
   slash suggestions, stale errors, disabled/loading/failed states, no browser-console errors.
7. Actual local pi-goal package in isolated temporary Pi settings: set, continue, pause busy, resume,
   complete through update_goal, token budget exhaustion and reload/restart restoration. Package may
   be read/copied from installed files but never alter them or call a paid provider. Keep tests that
   require the local package explicitly separate from hermetic generic regression fixtures.
8. Host lifecycle: no orphan children on close/disable/crash, bounded memory/process policy, reject
   excessive work with a recoverable message, cancel pending dialogs and requests on teardown.
9. Full diff audit; format/typecheck/lint, relevant suites and full suite; baseline-compare unrelated
   browser failures, never weaken or silently skip acceptance. Read final UI and actual model contexts,
   not just green test counts. Independent plan critique before product edits; parent self-review and
   verification accurately labelled, with any required independent implementation gates preserved.

<details>
<summary>Files, contracts, and implementation order</summary>

New core modules under `src/server/terminal/`: protocol (wire validation and types), projection,
worker (SDK runtime), host (child lifecycle/IPC), and manager (Durable policy/effects/registry glue).
New built-in `src/server/extensions/terminal.ts` exposes the hooks and delegates to the manager;
update loader ORDER/TITLES/OFF_BY_DEFAULT, PocketHost, app startup/recovery/close and settings exclusion.
Add new documents in `src/server/docs.ts`, no changes to old schema semantics. Add a generic custom
message projection for web/export without executing terminal renderers.

Commands/HTTP: factor/reuse submission policy without widening its access; catalogue/execute/dialog
routes in `http/conversation-routes.ts`, explicit command dispatch in `commands.ts`, generic UI view
in `room.ts` and `web/store.js`. Browser `commands.js` merges origin-aware entries and uses `/ext:`
aliases; `composer.js` renders a small terminal-extension UI component. Extensions sheet warns before
enabling and offers existing reload. Native choices/templates remain first.

One parent writer, sequential slices: (1) protocol/worker/host and hermetic tests; (2) projection and
Durable state/outbox/recovery, fault-injection tests; (3) per-conversation tools/events and real app
integration; (4) HTTP/catalogue/browser portable UI; (5) pi-goal acceptance, adversarial recovery/access
cases, documentation, final verification. Update this plan if concrete contracts change, do not fill
unknown semantics with no-ops.

</details>

<details>
<summary>Alternatives, verification commands, and rollout</summary>

The earlier same-process DefaultResourceLoader strategy was measured and rejected for module-state
leakage. A dependency patch or reliance on unexported uncached-loader internals is less maintainable
than isolated hosts and is not authorized. A full SDK/RPC agent backend would duplicate or replace
Durable ownership and is outside scope. Name-only bridging or native reimplementation of pi-goal
would not satisfy the request.

Run narrow `node --test test/<new-suite>.test.ts` checks per slice, immediate `node --check` for edited
web JS, then `npm run format`, `npm run check`, `npm run lint`, and full `npm test`. Use canonical test-only
TMPDIR on macOS and a temporary node_modules symlink for vendor assets if needed. The previous
544/547 result is baseline evidence only; freshly compare any remaining failures. Browser checks run
against the temporary app, never live user data. Rollout requires only the owner's normal server
restart followed by opt-in enablement; ask for restart only after work/checks finish. Rollback disables
the module; retain stored kinds and data, do not destructively remove plugin history.

</details>

## Review and completion status

Round 1: REJECT (`gpt-6-luna`, `xhigh`, read-only). Parent revisions: distinguish idle resume from
explicit reload/restart; define bindCore action mappings and require an actual-package binding probe;
replace per-operation snapshots with one shared live SDK view and ordered checkpoint-prefix commits;
promote SDK-caught lifecycle errors via onError to whole-host failure and test append-then-throw.
Round 2: OKAY (`gpt-6-luna`, `xhigh`, read-only), approving sequential implementation of this
production design. All four initial findings were resolved; this is not production acceptance.

The isolated actual-package binding probe now PASSES:
`node test/extension-bound-actions-probe.ts /absolute/path/to/pi-goal/index.ts`. It verifies set,
pause, resume, get/update tools, continuation, exact 15-token accounting, and resume-vs-reload
restoration using bindCore, real SDK command/tool contexts, and boundary dispatch, without provider
calls or persistent SDK sessions. Typecheck passes. This proves the binding contract, not the Durable
adapter or production dispatch path.

Implementation checkpoint: added `terminal/protocol.ts`, `terminal/worker.ts`, `terminal/host.ts`,
and `test/terminal-host.test.ts`. Eleven focused tests pass: bounded/tagged IPC, arbitrary commands/raw
arguments, same-cwd module isolation, synchronous custom state, concurrent command/pending-tool
shared view including newly arrived history, lifecycle-error invalidation, pre-load source/trust
filtering, runtime-added catalogue/tools with acknowledgement, local package filtering, no-install
missing-package failure, and cancellation/process disposal. Typecheck passes. No production app,
HTTP, web, native extension selection, or stored document integration exists yet. This is the first
bounded implementation slice; durability and end-to-end acceptance remain unfinished.

Independent code review (`gpt-6-luna`, `xhigh`, read-only) found one MEDIUM acceptance violation:
setActiveTools/refreshTools could mutate shared selection before rejecting a detached callback.
Parent reproduced it with a regression that also catches detached registerTool/registerCommand,
then guarded the SDK runtime API entrance and both stateful actions before mutation. The regression
failed before repair and all eleven tests pass afterward; typecheck passes. The repair is parent-
verified, not independently re-reviewed. The reviewer could not run fixture tests in its read-only
sandbox (EPERM creating a temp directory), and did not approve the repaired code.

Next: implement projection and the atomic ordered prefix/outbox adapter against real temporary
Pocket conversations. The native busy-conversation contract is now pinned by three passing
`terminal-durability.test.ts` integration tests: queued passive writes start no model request, triggering
custom content enters once through attributed admission, state/outbox changes roll back atomically,
and asOf document state follows forks without inheriting outbox work. This concrete evidence refined
the original placement assumption above: extension-only SDK metadata is in the rewindable state doc,
while every model-visible input/write goes through normal admission. No raw model-visible append is
performed by the bridge while busy.

Added `terminal/store.ts`, new document kinds in `docs.ts`, anchored entry merging in `terminal/entries.ts`,
and shared submission-policy helpers plus `Commands.submitTerminal`. Before the small policy-helper
refactor, the 24 sessions/spend/approvals tests passed; they also pass afterward. Ordinary submission
validation ordering and PiP restrictions are preserved. TerminalStore tests exercise actual temporary
Pocket apps: prefix replay and recorded results, combined rollback, restart in both admission crash
windows, requester/cost attribution, interrupted checkpointed tools, stop epochs, native cancellation
cleanup without a lock deadlock, passive messages, driver revocation, and spend blocking/retry.

Second-slice independent review (`gpt-6-luna`, `xhigh`, read-only) requested changes for two MEDIUM
findings. Parent dispositions:

- Extra automatic title request: not reproduced—the then-current eight-word preview stayed below
  the existing title threshold. A long/multiline-input regression confirmed one model call. Still
  replaced that fragile threshold coupling with an explicit `preview` title policy for terminal
  admission; native submissions keep default `automatic` behavior, and actual model input is uncut.
- Unbounded hot receipts and drain: reproduced both issues with failing regressions, then implemented
  the conservative cold-receipt/hot-index retention and batch/pending bounds specified above. Tests
  cover 80 completions, old result retrieval and no unsafe rerun, 80 unique message admissions over
  32/32/16 batches with settled outbox pruning, and atomic overflow rejection/unfinished-operation caps.

Fresh `npm run format`, `npm run check`, `npm run lint`, and 51 focused/policy tests PASS. These are
parent verification results; the reviewer could not run temp-fixture tests under its read-only sandbox.
The reviewer has not independently re-reviewed the repairs. No full-suite green claim is made for
this intermediate slice.

Next: finish and verify SDK projection and registry/lifecycle manager integration, then HTTP/browser
wiring and actual pi-goal end-to-end acceptance. Ordinary native model history stays only in Pocket;
projection merges extension-owned anchored SDK entries and correlates admitted custom-message rows
so content/metadata are not duplicated. Check active context against Pocket's actual context after
edits, compaction and reset—do not assume a plain SDK append-only view computes the same context.
No app startup/module/HTTP/web integration exists yet. The original in-process probe
still intentionally fails its isolation case; it is retained as historical evidence, not a feature test.

Complete
only after the required acceptance matrix has direct evidence, or stop with a genuine missing
permission/dependency/irreconcilable contract and attempted alternatives. Ordinary design work is not
a user blocker.
