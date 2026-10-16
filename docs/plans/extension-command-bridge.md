# Terminal extension command bridge

Status: feasibility plan reviewed; straightforward in-process loading failed the isolation gate.
Production implementation is blocked on revising the extension-host architecture.

## Outcome and scope

Install a Pi extension once, then use its registered slash commands in Pocket without adding
plugin-specific command handlers. Commands act on the current Pocket conversation, not a separate
terminal conversation. Pi Durable remains the authoritative store and execution engine.

Minimum eventual release: shared configuration discovery, per-conversation extension instances,
command autocomplete and execution, portable notifications/dialogs, extension tools, custom state,
and the lifecycle/continuation subset needed by `pi-goal`. A discovered command is not evidence that
its extension works. Do not advertise `pi-goal` support until the full acceptance flow passes.

Immediate deliverable: an isolated, repeatable feasibility probe and an evidence-backed decision
about whether the existing SDK extension runner can be adapted without two authoritative sessions.
Production implementation is gated on that result and a concrete reviewed implementation plan.

Deferred: custom terminal components, terminal shortcuts/themes, arbitrary session-file mutation,
full provider/MCP integration, and universal compatibility with every extension. No new dependencies,
live-server restart, changes to the real Pi install, commits, or PRs.

## Current behavior

Pocket's browser handles a fixed command list. Its prompt endpoint also lists templates and skills.
Unknown slash input is submitted as ordinary model text. Pocket loads its own Pi Durable extensions,
not the terminal extension runtime. `/until` is a separate built-in shell-check feature.

A local isolated probe loaded the actual installed `pi-goal` successfully with the existing Pi SDK:
`goal`, three tools, and four event types were discovered. Its status handler produced a notification.
Its objective handler failed with the SDK's unbound-runtime error. This proves loading, not end-to-end
compatibility.

## What changes

- Commands come from a conversation-scoped server catalogue with plugin provenance.
- A recognized extension command executes server-side after authorization; it is not sent to the
  model as ordinary user text.
- Compatible extensions operate on Pocket history, tools, model selection, and durable work.
- Owner-approved loading and project trust precede executing extension factories.
- Unsupported operations and load/handler failures have visible, actionable diagnostics.

## What stays the same

- Existing Pocket commands, skills, templates, `/until`, and native drop-in extensions continue working.
- Pi Durable owns conversation history, task recovery, forks, and usage accounting.
- Existing access, driver, plan/guard, model-choice, and spend policies remain authoritative.
- Terminal session files and extension settings are not rewritten by Pocket.
- Ordinary absolute-path messages such as `/etc/hosts` remain valid ordinary messages.

## Desired user flows

1. The owner installs an extension through Pi's normal configuration. Pocket discovers the same
   configured resources on the same host and agent directory. Ephemeral CLI `-e` arguments are not
   shared configuration and are outside automatic discovery.
2. The owner enables the extension for Pocket. An untrusted project's code is not executed just to
   build a command list. Discovery/loading failures identify their source and leave Pocket usable.
3. Typing `/` lists enabled commands for the current conversation and working directory. The list
   refreshes after configuration/reload/cwd changes. Loading or failure is distinguished from an empty list.
4. Sending a known plugin command runs its handler with raw arguments after permission checks.
   Commands may execute while the model runs; do not blindly put `/goal pause` behind the run it stops.
   A stale advertised command returns an error rather than silently becoming an LLM prompt.
5. Notifications, statuses, and text widgets have generic browser representations. Confirmation/input
   requests are associated with a conversation and authorized responding person, with cancellation on
   disconnect, reload, timeout, or loss of control. Custom terminal UI is explicitly unsupported.
6. A command can persist custom state and cause a model turn. Follow-up messages retain the requesting
   person's attribution and respect spend/guard/plan policies. Stop and pause suppress unwanted continuation.
7. A browser reload reconnects to stored state. A server restart restores state without rerunning an
   arbitrary partially executed handler. Unsupported recovery is reported as interrupted, not retried.

Representative UI (behavioral examples, not prescribed styling):

```text
/                          /goal — Set, view, pause, resume…  [pi-goal]
                           /until — Continue until a shell check passes [Pocket]

/goal pause                Status: Goal paused

/goal new objective        Replace goal?
                           Current: …  New: …   [Cancel] [Replace]

Extensions → pi-goal       Disabled · Owner must enable
Extensions → plugin-x      Failed to load · <source and error> [Reload]
/terminal-only-command     Unsupported in Pocket: custom terminal UI
```

Name conflicts must not silently change an existing Pocket command's behavior. Preserve Pocket's
short names and provide an explicit stable qualified invocation for colliding plugin commands.
Use the SDK runner's actual invocation names for extension-extension collisions (`name:1`, `name:2`);
the exact additional Pocket-collision alias must be specified and tested in the production plan.

## Feasibility gate: one bounded probe

Build a Node-run probe under `test/` using the existing SDK and isolated test-app helpers. It must
not be part of server startup or depend on the user's installed plugins or real credentials.
Generate a small ordinary Pi extension fixture inside the test's temporary agent directory.
Use the real SDK loader and `ExtensionRunner`; do not replace the factory API with a hand-built mock.

Prove or disprove all of the following before designing the production adapter:

1. Discover and invoke an arbitrary fixture command through the SDK command registry and context.
   Observe notification and status effects; commands are not model prompts by default.
2. Give two conversations independently loaded extension instances. Exercise top-level mutable
   plugin state as well as factory-local state; neither may leak between conversations.
3. Seed a real Pocket conversation with user/assistant history and create a fork with different later
   history. Through the SDK command context, read the current branch before and after reconstruction;
   assert inherited entries are present, original entry identities remain addressable, and the sibling
   branch's later history is absent. An empty SDK session with only plugin state is a failure.
4. Bind synchronous `appendEntry()` to an explicit effect boundary: expose read-your-writes within
   a handler, commit custom data to a real temporary Pocket conversation before success, destroy
   the runtime, reconstruct it from durable entries, and read the same branch-sensitive state.
   Any in-memory projection is disposable and must never become a second persistent session.
5. Demonstrate failure behavior: handler throws before commit, commit fails, and process/runtime
   disappears after commit but before reply. Distinguish safe state writes from arbitrary external
   side effects; do not claim general exactly-once execution of third-party JavaScript.
6. Translate one `sendUserMessage` effect through Pocket's existing submission path with the owning
   user. Verify model context and usage attribution; no direct provider calls.
7. Use a combined-effect command that calls `appendEntry()` then `sendUserMessage()`. Handler failure
   discards buffered Pocket-managed effects and invalidates the disposable runtime. Commit failure must
   expose neither state nor an admitted message. Persist state plus an attributed message intent atomically
   in one Durable commit before acknowledging success; drain intents with stable request IDs. A crash
   after commit but before submission is recovered, and a crash after admission but before marking the
   intent delivered must not admit a second message. Assert state-before-model visibility and requester/
   usage attribution. If Durable cannot express this boundary without a second persistent session, fail.
8. Exercise lifecycle-driven follow-up scheduling with a bounded fixture. Verify event ordering,
   dynamic tool selection, stop/pause, spend exhaustion, and recovery deduplication. If the available
   Durable hooks cannot supply the necessary event semantics, stop and document the exact mismatch.

9. Before any project extension import/factory execution, resolve project trust and owner enablement.
   Use fixture files with separate import-time and factory-time marker writes. Exercise untrusted/enabled,
   trusted/disabled, and trusted/enabled combinations; neither marker may exist in the first two cases.
   `discoverAndLoadExtensions()` is not a safe trust-gated discovery API: it scans and executes local
   project extensions. Test prefiltered resource selection or a trust-aware `DefaultResourceLoader` path;
   record inability to select resources without execution as a blocker. Also check discovered user paths
   against owner enablement before importing them.

The probe may establish an incompatibility rather than a successful bridge. That is a valid outcome.
Do not weaken it to a command-name demo or silently make unsupported APIs no-ops to get a pass.

## Acceptance criteria for eventual production work

- A plugin introducing a previously unknown command appears in `/` and executes without a Pocket
  source change; the catalogue includes its origin and deterministic invocation name.
- Native commands, templates, skills, absolute-path input, attachments, and busy-run behavior retain
  their defined behavior; collisions, stale names, and unknown names are tested explicitly.
- Viewers/non-drivers cannot invoke mutation commands or answer another person's dialogs.
- Untrusted project code and owner-disabled extensions never execute during discovery or startup.
- State and tool exposure are isolated between conversations and follow forks/cwd/reload correctly.
- Custom state writes and continuation decisions recover without duplication at tested crash boundaries;
  unsafe interrupted plugin handlers/tools are not automatically replayed.
- `pi-goal` acceptance uses a controlled local fixture/package, not a network install: set an objective,
  observe a turn and continuation, pause while busy, resume, complete through its tool, and reload/restore
  state and token-budget accounting. No production code may special-case `goal`.
- Supported UI works on mobile and desktop; unsupported operations never look like successful actions.
- Fresh typecheck, lint, full tests, and browser checks pass before asking for a server restart.

## Risks and remaining blockers

- The Pi SDK API includes synchronous side effects and session reads; Durable commits are asynchronous.
  Buffered effects require explicit ordering, failure, and visibility semantics. A second JSONL session
  mirrored into SQLite is not an acceptable shortcut.
- Native Durable hooks are request/response/yield/tool boundaries, not a one-to-one copy of Pi's
  turn/agent/session events. Continuation and budget accounting cannot be guessed.
- Plugins may use module-level state, timers, child processes, or files. Fresh factories alone are not
  proof of isolation, and in-process adapters are not sandboxes.
- The bridge must not bypass Pocket's policy by invoking a second agent loop or direct unguarded tools.
  Extension code itself already has host-level privileges; enabling it is an owner trust decision.
- The installed SDK and a terminal Pi executable may differ. Shared configuration does not guarantee
  cross-version API compatibility or share packages installed on another machine.
- The reviewed probe now reproduces a concrete blocker: `DefaultResourceLoader` caches a plugin's
  module factory for the same cwd. Separate runners have separate factory closures but share mutable
  module-scope state. This is directly relevant to `pi-goal`, which keeps its goal at module scope.
- Separate extension-host processes eliminate this specific leak in the isolated probe. They are a
  candidate architecture, not proof of state transport, crash recovery, event fidelity, or resource cost.
  The next design must decide process lifetime/limits and an IPC effect protocol before implementation.
- Production adapter architecture is not yet approved.

## Critic findings

Round 1: REJECT (OpenAI Codex `gpt-6-luna`, `xhigh`, read-only). Three material findings:

- Trust could be asserted only after a project factory already executed. Added marker-based import and
  factory exclusion checks and rejected blind use of `discoverAndLoadExtensions()` for production discovery.
- State round-tripping could pass with an empty SDK session unrelated to Pocket history. Added seeded
  history, fork isolation, stable entry identity, and reconstruction assertions through command context.
- Separately tested state writes and messages missed their ordering/recovery gap. Added atomic state-plus-
  outbox intent, stable request IDs, failure invalidation, and both delivery crash-window assertions.

All three findings were addressed in the probe contract. Round 2: OKAY (same model/thinking,
read-only), approving only the feasibility probe, not production implementation. The immediate
review scope was the feasibility gate and preservation constraints; the eventual production list remains
an acceptance target, not an approved file-level design.

## Probe results

Run `node test/extension-runtime-probe.ts` from this worktree. This intentionally exits nonzero when
a mandatory architecture gate fails; it is not included in the `*.test.ts` regression suite.

- PASS: arbitrary plugin command registration and invocation through the real SDK context.
- PASS: a command reads a real Pocket fork's inherited and branch-specific history, preserving entry IDs,
  before and after reconstruction, without an SDK session file. Bounded fixture only: full compaction and
  context-edit projection remain unproven.
- PASS: explicit resource loading with prefiltered paths prevents import-time and factory-time marker
  writes for denied sources; accepted sources execute. This does not implement shared config discovery
  or bind Pocket's actual trust/owner settings yet.
- FAIL: two `DefaultResourceLoader` instances using one cwd share mutable module state. The second
  conversation sees `moduleCounter=2` instead of `1`; factory-local state is independently `1`.
- PASS, alternative only: two isolated extension-host processes loading the same fixture and cwd each
  see `moduleCounter=1` and `factoryCounter=1`. No agent loop or provider call runs in those children.

The probe stops short of building the state/message adapter because the proposed in-process loading
strategy fails its isolation prerequisite. Atomic state-plus-outbox recovery, lifecycle continuation,
portable dialogs, and real `pi-goal` end-to-end compatibility are NOT proven. No product code changed.

### Verification checkpoint

- `npm run format`, `npm run check`, and `npm run lint`: passed.
- Probe run twice: identical four-pass/one-fail result; both isolated-process alternatives passed.
- The worktree initially lacked `node_modules`, which caused browser vendor imports to fail. Added a
  temporary `node_modules -> ../../node_modules` link; no dependency installation or package changes.
  Removed it after verification (the directory-only ignore pattern does not hide a symlink). Recreate
  it with `ln -s ../../node_modules node_modules` before rerunning browser tests.
- Full suite with canonical macOS `TMPDIR`: 544/547 passed. Canonicalizing the test-only temp path
  avoided `/var` versus `/private/var` equality failures without modifying unrelated tests.
- Serial rerun of the three affected UI files: 45/48 passed, reproducing the same three failures:
  `composer-focus-ui.test.ts` desktop-session opening timeout; `mobile-ui.test.ts` desktop Alt+A PiP
  shortcut/focus mismatch; `status-line-ui.test.ts` launcher timeout. These suite inputs are unchanged
  from the worktree's base commit, and the probe is not in the suite's glob. Full-suite green is NOT claimed.
- No production code, dependency manifests, existing tests, live data, or terminal settings changed.
  No commit, PR, or restart was performed. Implementation/probe self-review is the parent's own work;
  the independent Critic reviewed the probe plan, not the executable or an eventual production bridge.

Next architectural choice: process-isolated extension hosts with Pocket-owned state/effects versus
an SDK-supported fresh-module loading facility. The first avoids patching dependencies and keeps
Durable authoritative, but adds lifecycle/IPC/resource-management responsibilities. A fresh factory
alone is insufficient. Neither option is approved as production architecture by this probe review.

## Recommended handoff

Executive / Bob-led, one writer in this worktree. Run the feasibility probe first. If it passes,
write and review the production design, then implement sequentially: runtime/state; tools/events;
HTTP command catalogue/dispatch; browser command/UI integration; recovery/security/browser verification.
Do not fan out code ownership across the unresolved runtime boundary.

<details>
<summary>Production paths and dependency evidence</summary>

All repository paths below are relative to this worktree:

- `web/commands.js`: fixed `COMMANDS`, template/skill cache, `parseCommand`, suggestions. Current own-command
  parser excludes `:` even though SDK conflict invocation names can contain it.
- `web/composer.js`: `runCommand`, `choose`, input submission and clearing after success.
- `web/store.js`: HTTP actions and conversation-scoped state.
- `src/server/http/conversation-routes.ts`: authenticated conversation routes, prompt catalogue endpoint.
- `src/server/commands.ts`: `submit` authorization, expansion, spend check, requester attribution, Durable submit.
- `src/server/app.ts`: resource settings, registry/harness startup, extension loader, recovery, shutdown.
- `src/server/reload.ts`: Pocket's own extension-module loading and reserved names.
- `src/server/extensions/goals.ts`: existing replay-aware `GenerationTask.onYield` continuation pattern.
- `src/server/skills.ts`: existing trust decisions; skill-loading permissiveness must not be copied for code.
- `src/server/pi-sessions.ts`: imported terminal sessions deliberately omit terminal extension state.
- `src/server/docs.ts`: existing stored document schemas must not change identity/scope/history/fork settings.
- `test/helpers.ts`: temporary agent/data directories and scripted models; reuse for probes/tests.

The installed `@earendil-works/pi-coding-agent` exports `DefaultResourceLoader`,
`discoverAndLoadExtensions`, `ExtensionRunner`, and `createExtensionRuntime`. The runner exposes
`getRegisteredCommands()`, `getCommand()`, `createCommandContext()`, `bindCore()`, and event dispatch.
Its `SessionManager` can be in-memory but remains a distinct API with session-tree assumptions.
Pi's existing RPC supports command discovery/invocation and portable UI, but adopting RPC sessions
as Pocket's engine would be a backend/session-ownership migration, not a thin slash-command fix.

</details>

<details>
<summary>Alternatives and decision rule</summary>

1. Add command names only: reject; handlers still lack runtime behavior.
2. Reimplement each plugin in Pocket: reject as the default; violates install-once generic commands.
3. Reuse SDK loader/runner with explicit Durable adapters: candidate, subject to the feasibility gate.
4. Put actual SDK/RPC sessions behind Pocket: stronger native extension semantics, but duplicates or
   replaces conversation ownership and recovery. Revisit only if option 3 fails and the user authorizes
   the backend scope change. RPC also does not solve arbitrary terminal-only UI.

Choose option 3 only after proving state/event/continuation semantics, not because discovery works.
If no defensible path preserves the constraints, report the probe evidence, exact incompatibility,
and the smallest architecture decision needed from the user; do not implement speculative adapters.

</details>

<details>
<summary>Verification and working-tree safety</summary>

Worktree: `.worktrees/extension-command-bridge`, branch `extension-command-bridge`, base `de612d5`.
Main-checkout edits and other worktrees belong to other work; do not stash, move, or alter them.
Dependencies currently resolve from the parent checkout; do not mutate that dependency tree.

For the isolated probe: run its documented Node command twice and capture per-case assertions.
Expected current result: four passing cases and the reproducible in-process isolation failure (exit 1).
This is a failed architecture gate, not a successful feature implementation.
For production edits: narrow tests first, `node --check` immediately after each web edit, then
`npm run format`, `npm run check`, `npm run lint`, and `npm test` in this worktree. Format only owned
changes if the repository-wide command changes unrelated files. Use the temporary app for browser
checks, never live user data. Inspect the final diff and leave server restart to the owner.

</details>
