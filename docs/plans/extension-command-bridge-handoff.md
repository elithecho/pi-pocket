# Extension-command bridge — session handoff

**Superseded continuation status:** read
[extension-command-bridge-progress.md](extension-command-bridge-progress.md) first. The composer/UI
wiring described below as missing is now implemented and tested. The checkpoint commit mentioned
below was not present: the continuation found `HEAD=de612d5` and uncommitted implementation files.

## Read this first

The owner requested this handoff and a fresh session. Stop implementation in the old session. The
feature is **not complete**. Do not mark the goal complete or ask for a live-server restart yet.
The old thread's goal is still active: the owner should use `/goal pause` there before moving work.
Do not assume goal state automatically transfers to another session.

**Working directory:** `/Users/elijah/Workspace/pi-pocket/.worktrees/extension-command-bridge`

**Branch:** `extension-command-bridge`, created from `main` at `de612d5`.

The owner authorized a **WIP checkpoint commit** before moving sessions. This handoff and the
implementation are included in that checkpoint; use `git log -1` to identify it and inspect any later
working-tree changes separately. The feature remains incomplete. Leave the dirty main checkout and
every other worktree alone. No push, PR, deployment, dependency installation, owner configuration/
session modification, or live restart has been performed or authorized.

Suggested new-session prompt:

> Read `docs/plans/extension-command-bridge-handoff.md` in this worktree and continue the generic Pi
> extension bridge to completion using the documented Bob workflow and acceptance contract. Reuse the
> existing implementation and evidence; do not restart discovery or mistake the partial UI for done.
> If activating a new goal, use the outcome/acceptance/constraints below as the contract.

## Outcome / completion contract

The user wants: **install/configure a plugin in terminal Pi on this host, then use its registered slash
commands in Pocket without implementing each plugin separately**. `/goal` is the initial acceptance
case, not a production special case. Use shared applicable Pi configuration/package filters and project
trust; ignore ephemeral CLI-only `-e` arguments. Pocket/Pi Durable must remain authoritative for model
execution, conversation/history, forks, permissions, spend and recovery. Never add a second persistent
SDK/JSONL conversation or competing agent loop.

Complete only after all required behavior has direct evidence:

- Generic dynamic command catalogue, `/` suggestions and server dispatch with raw arguments;
  deterministic collisions (native short names win, `/ext:<SDK name>` addresses plugins), stale-list
  errors, reload/cwd changes, and preserved templates/skills/paths/attachments/native commands.
- Owner-approved loading and pre-import trust/config filtering; no disabled/untrusted code execution.
  Viewers/non-drivers cannot invoke commands or answer another person's dialog.
- Isolated per-conversation module state; branch-aware history, context edits/compaction/reset and
  custom state; native tool execution with dynamic activation and guard/plan restrictions.
- Supported lifecycle events, attributed/policy-checked continuation, stop/pause/spend behavior,
  portable notifications/status/widgets/dialogs, cancellation on timeout/disconnect/lost control.
  Unsupported API/event capabilities must be visible, not silently successful.
- Atomic Pocket-managed effects/outbox with read-your-writes; failed/uncertain handlers not replayed;
  crash recovery before commit, commit-before-admission and admission-before-delivery-mark without
  duplicate model input. Preserve original requester and usage accounting.
- Actual local pi-goal acceptance through production paths: start, continuation, pause while busy,
  resume, completion tool, token limit and reload/restart restoration. No paid provider calls in tests.
- Real temporary-app browser checks on desktop/mobile, console errors inspected, final diff audit,
  documentation updated, format/typecheck/lint/relevant tests/full suite freshly checked. Any remaining
  unrelated test failure needs evidence/comparison and explicit reporting; missing bridge acceptance
  cannot be waived by a mostly green suite.

Use small verified slices. Keep this evidence checkpoint current. Ordinary engineering choices are
not user blockers. Stop only for an actual missing authorization/dependency/required model/tool or an
irreconcilable contract after defensible alternatives have been attempted; report exact evidence and
remaining criteria. No token budget was requested.

## What already works

1. The straightforward SDK loader was measured: separate in-process runtimes for the same cwd share
   module-level plugin state. This is real, and pi-goal stores its goal at module scope.
2. The chosen implementation uses **one lazily created Node extension-host child per conversation**,
   real SDK loader/ExtensionRunner, no worker model loop or persistent SessionManager. A process
   boundary isolates memory, **not OS permissions**. Owner-enabled plugins remain trusted code.
3. Worker actions are bound via `bindCore`; AsyncLocalStorage attributes effects across awaits.
   Shared live SDK view plus sequenced effects/checkpoint prefixes permits a command to run while a
   tool/dialog waits. API entrance guards prevent caught detached callbacks mutating registries/state.
4. Pocket owns a rewindable/asOf ledger containing **only extension-owned SDK entries**, not copied
   ordinary history; operational work/outbox is latest/initial and not inherited by forks. All actual
   model-visible messages use normal input/write admission, including when busy.
5. The real manager is connected to app startup/recovery/shutdown, per-conversation native tool
   selection, lifecycle hooks, normal `Commands.submit`, and module enable/disable/reload.
6. Five production-manager integration tests passed. The actual installed pi-goal passed **three
   end-to-end backend tests**, not just the older binding probe.
7. HTTP command/dialog endpoints and remote browser-command support have now been added, but that
   most recent UI/HTTP work has **not** had runtime/browser verification yet.

## Current files

### Core implementation (all under this worktree)

- `src/server/terminal/protocol.ts`: bounded TypeBox-derived wire DTOs/codecs, typed messages/tool
  results/custom entries, snapshot aliases and exact active-context payload.
- `src/server/terminal/worker.ts`: SDK loading with prefiltered paths, no-install package resolution,
  guarded action bindings, shared view and canonical context proxy, effects, dialogs, events/tools.
- `src/server/terminal/host.ts`: child startup/IPC validation, requests, acknowledgements, catalogue
  updates, cancellation/disposal. Initialization now has a 15-second timeout; operations up to 10 min.
- `src/server/terminal/store.ts`: operation admission/receipts, atomic effect prefixes, outbox admission,
  stop epochs and native cancellation. Hot settled caches: 64 records / 2 MiB each; cold per-key
  receipts preserve old results and unsafe-retry prevention. Pending cap: 256 / 8 MiB. Drain batch: 32.
- `src/server/terminal/entries.ts`: merge/relink anchored extension entries into one SDK branch.
- `src/server/terminal/projection.ts`: project real fork-aware Pocket history and exact native active
  context. Assistant identities use generation task IDs (with numeric native aliases), so pending
  lifecycle answers retain their identity after publication. Custom messages correlate to admitted
  input/write rows to avoid duplicate content. Native boundaries retain metadata; exact context
  methods use Pocket's actual contributions rather than independent SDK compaction guesses.
- `src/server/terminal/commands.ts`: reserved native short names and raw extension input parsing.
- `src/server/extensions/terminal.ts`: `pocket-terminal` hooks. **Off by default**. ORDER places it
  before goals/plan/guard so plugin argument mutations are checked by native restrictions afterward.
- `src/server/docs.ts`: NEW `pocket.terminal-state`, `pocket.terminal-work`, and
  `pocket.terminal-receipt` kinds only; old stored kinds/semantics were not changed.
- `src/server/commands.ts`: shared access/model/spend helpers, `submitTerminal`, explicit preview-only
  title policy (no extra title request), slash-command dispatch and passive command receipts, stop.
- `src/server/app.ts`, `host.ts`, `reload.ts`: manager and native extension integration, dynamic tool
  extensions excluded from global defaults, recovery before resume, teardown, enable/reload handling.
- Dynamic tool namespace is `pocket-terminal-tools-<conversation>` (reserved by Pocket's existing
  `pocket-*` rule), selected only in that conversation and removed/restored on disable.

### Most recent, incomplete browser work

- `src/server/http/conversation-routes.ts`:
    - `POST /api/c/:id/terminal/command` `{name,args,requestId}`.
    - `POST /api/c/:id/terminal/dialog` `{id,value}`.
    - Existing prompts endpoint now merges plugin entries with origin and explicit aliases.
- `src/server/room.ts`: projects only status/widget UI from TerminalStateDoc, plus per-client owned
  dialogs and sanitized problems. It never sends the full SDK-state ledger to browsers.
- `src/server/app.ts`: added `server.extensionRevision` for slash-cache invalidation.
- `web/store.js`: terminal view state, command/answer actions, terminal-editor event.
- `web/commands.js`: cache loading/error/revision state, plugin suggestions/dispatch, raw args,
  native precedence, qualified aliases, duplicate-alias suppression.
- **NEW `web/terminal.js`:** generic `TerminalPanel` / inline confirm/input/select/editor form. This
  file passes JS syntax check but is **NOT imported/rendered by composer yet**, and has no CSS yet.
- **`web/composer.js` has not been changed.** Important missing consumers are listed below.
- **`web/sheets/extensions.js` has not been changed:** the explicit trusted-code enable warning is
  still missing. Do not call the owner-enable experience finished.

## Next actions (do these, not more foundational rediscovery)

1. Finish composer/browser wiring:
    - Import/render `TerminalPanel` above the composer inside the dock, and below the editor for
      widgets with `placement: "belowEditor"`. Show read-only statuses/widgets for viewers too.
    - Pass `showCommands: text.startsWith("/")` for remote-command loading/error UI.
    - Add an effect to refresh slash resources for conversation/cwd/server-start/revision/cache-null
      changes while slash input is open. Existing `update()` calls loadTemplates only when text changes.
    - `runCommand` currently calls `command.run(arg)` only. Pass a stable command request ID, rotate it
      after success, and ensure editing/retrying doesn't accidentally re-execute an uncertain command.
      `actions.terminalCommand` accepts a requestId but currently defaults to a new uid if not passed.
    - Handle `composerInsert.replace` for terminal-editor events, including replacing with empty text;
      current insert effect only appends text and returns early for empty strings.
    - Add phone-safe CSS for `.terminal-dialog`, messages/buttons and `.terminal-widget`; reuse normal
      bars. Components may return arrays so status bars remain direct dock children. Dialogs must not
      get squeezed into the compact one-line goal-bar layout. Keep thumb targets about 40 px.
    - Add owner warning before enabling terminal.ts in Extensions sheet (plugins have OS rights),
      preserve off-by-default behavior, clear slash cache after reload/enable where appropriate.
    - Run `node --check` immediately after each web JS save, keep the page loadable after each save.
2. Add real browser/HTTP tests: slash suggestions, native collisions/qualified aliases, raw args,
   dialogs/status/widgets/placement/editor, stale errors, viewer/non-driver/cross-user answers,
   disconnect/timeout/lost-driver cancellation, desktop/mobile width and console errors.
3. Strengthen native integration acceptance: forks/compaction/context edits/reset through the worker
   projection, plugin tool argument mutation followed by native guard/plan checks, host failure/cwd/
   trust changes, pending user work and stop, restart with active/queued autonomous work.
4. Audit unsupported capabilities: worker accepts more event types than the manager currently emits.
   Implement them or report unsupported registrations clearly; do not silently advertise fidelity.
   Provider/model-loop/session replacement/nested execution/custom terminal UI are intentionally
   unsupported. Terminal renderers must never execute in a browser.
5. Update docs/map.md, architecture.md, features.md and extension compatibility/operations docs.
6. Final integrated code review/repairs and verification. Parent retains implementation/repair ownership.
   No restart until done/checks audited, and then ask owner to restart normally and opt in.

## Checks and evidence — exact scope

**Fresh handoff check:** `npm run check` PASSED after the latest HTTP/room/browser changes.
`web/commands.js`, `web/store.js`, and new `web/terminal.js` each passed `node --check` immediately
following their saves. Latest long lines/markup have NOT had a final format/lint pass.

Earlier current-feature evidence (rerun after remaining integration):

```sh
npm run format
npm run check
npm run lint
node --test test/terminal-store.test.ts test/terminal-host.test.ts \
  test/terminal-durability.test.ts test/sessions.test.ts test/spend.test.ts test/approvals.test.ts
# 51 passed

node --test test/terminal.test.ts
# 5 passed: generic command/tool+lifecycle, same-cwd isolation, idle rehydrate/restart,
# normal submit/raw args/dedup/native-name/path behavior, disable restores native loadout.

PI_POCKET_GOAL_EXTENSION=/Users/elijah/.pi/agent/npm/node_modules/pi-goal/.pi/extensions/pi-goal/index.ts \
  node --test test/terminal-goal-acceptance.ts
# 3 passed: actual set/continue/update_goal completion; pause during model request,
# paused restart/resume; explicit tiny token budget gives one wrap-up turn.
```

The actual-package acceptance file intentionally is NOT named `*.test.ts`, so the default suite does
not depend on the owner's installed package. It reads that package; it only writes temporary Pi
settings from test/helpers.ts, and uses scripted models. No actual provider calls.

Older probes:

- `test/extension-runtime-probe.ts`: intentionally exits 1 for the measured in-process isolation
  failure; four other cases pass. Historical architecture evidence, not a failing feature test.
- `test/extension-bound-actions-probe.ts /path/to/pi-goal/index.ts`: real package's SDK binding passes;
  superseded for feature evidence by the actual production-manager acceptance above.

Logs available under `/tmp` (do not rely on them instead of rerunning):
`pi-pocket-terminal-goal-acceptance.log`, `pi-pocket-terminal-manager-tests.log`,
`pi-pocket-terminal-stage-two-tests.log`, `pi-pocket-terminal-handoff-check.log`.

### Full-suite / worktree setup

There is currently NO worktree `node_modules` link. Node module resolution finds parent dependencies,
but browser vendor assets use APP_ROOT/node_modules and need this temporary link:

```sh
ln -s ../../node_modules node_modules
# ... run UI/full checks ...
unlink node_modules
```

The link itself is not hidden by the directory-only ignore rule. Do not install or modify parent
dependencies, and only unlink the known symlink, never remove an actual directory.

On macOS use canonical test-only TMPDIR:

```sh
TMPDIR="$(node -p 'require("node:fs").realpathSync(require("node:os").tmpdir())')" npm test
```

Pre-implementation baseline: 544/547 passed after that setup. Three unchanged-at-that-time failures
reproduced in a serial rerun: composer-focus-ui desktop session opening timeout, mobile-ui desktop
Alt+A PiP focus, status-line-ui launcher timeout. Do NOT presume current failures are baseline: app,
HTTP and browser code have now changed. Freshly run and correlate/compare. No full suite has been run
after the manager/UI integration. New extension roster expectations may legitimately need updates;
do not weaken behavioral tests to hide regressions.

## Reviews / ownership

Read AGENTS.md and applicable global Bob/workflow/planning skills. This is Executive/Bob-led work;
parent owns architecture, implementation, fixes, tests and final judgment. No delegated writers.
The workflow-orchestration skill directory was empty; no graph was authored or launched.

- Feasibility plan and separate production plan each had two independent Critic rounds; both ended
  OKAY. Production design is in `docs/plans/extension-host-implementation.md`. The older
  `extension-command-bridge.md` is historical feasibility evidence.
- Read-only reviewers ran via `codex exec --ephemeral --sandbox read-only --model gpt-6-luna
-c model_provider='"openai"' -c model_reasoning_effort='"xhigh"' ...`, after routing checks.
  Use the governing route and never silently substitute models/providers.
- First bounded code review found detached setActiveTools/registration mutation; regression failed
  before repair and now passes. Second found unbounded work/drain and suspected a title request.
  Bounds were reproduced and repaired, and title behavior now uses an explicit no-generation policy.
- Reviewer sandboxes could run typecheck but temp-fixture tests hit EPERM; parent ran the tests.
  Repairs have not had independent re-review. No independent verifier or final integrated review yet.

## Known audit targets (not all proven bugs)

- The latest proactive resetHosts rehydration, editor-recipient fix, 15-second initialization timeout,
  HTTP catalogue aliases, room fields and browser changes came after the last manager/goal test runs.
- The goal restart test so far restarts a PAUSED goal. Test active/queued autonomous continuation
  across reload/restart and document correct interruption/budget behavior; don't infer it from that test.
- `message_end` uses a generation-task key: provider retries may need an attempt discriminator so a
  failed attempt's recorded event does not hide the later successful message event.
- Verify overlapping-operation editor effects go to their ORIGINAL operation requester (recently
  changed to look that user up), not the requester of whichever response committed the shared prefix.
- Review the new manager for lifecycle/authority/teardown races and bounded resource behavior. A
  process boundary does not sandbox intentionally malicious or daemonizing plugin OS side effects.
- Browser panel/CSS/cancellation/error loading are unfinished, not verified success claims.

No user input is required for the next engineering step. Resume implementation in the new session;
keep the active goal incomplete until the actual final acceptance matrix and artifacts are audited.
