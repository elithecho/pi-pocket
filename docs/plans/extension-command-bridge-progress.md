# Extension bridge — 2026-10-15 acceptance and evidence record

**Feature acceptance complete; independently verified. Uncommitted and not deployed.**
See [the final completion audit](#final-completion-audit) for the current verdict and exact results.
Earlier sections below retain the chronological work/review history; their open-gate statements are
superseded by that final audit. This record also supersedes
[the previous handoff](extension-command-bridge-handoff.md).
The governing outcome and acceptance contract remain in
[extension-host-implementation.md](extension-host-implementation.md).

## Working tree / safety

Work remains entirely in `/Users/elijah/Workspace/pi-pocket/.worktrees/extension-command-bridge`.
Contrary to the previous handoff's checkpoint-commit claim, the checkout started this continuation at
`de612d5` with the implementation modified/untracked. All work remains uncommitted. No owner settings,
installed package files, dependency versions, live data or other worktrees were changed. No push,
PR, deployment or live restart was performed. The owner subsequently requested and activated the
completion goal described below.

The referenced workflow-orchestration skill file is still absent. No graph/delegated writer was
launched. Parent owned implementation and repairs; independent read-only slice reviews used the
prescribed OpenAI Codex `gpt-6-luna` / `xhigh` route.

## Implemented in this continuation

- Composer imports/renders `TerminalPanel` above the editor and below-editor widgets, including
  read-only status/widgets for viewers. Slash loading/errors have retry UI; cache refresh follows
  conversation/cwd/server/module changes. Plugin suggestions fill the editor, never auto-execute.
- Portable confirm/input/select/editor forms and mobile-safe styles. Text remains plain text;
  dialogs have real 40 px targets and do not inherit compact single-line bar styling.
- Owner enable warning explicitly states configured plugins have OS rights and child processes do
  not sandbox permissions. Off-by-default roster expectation updated without weakening behavior.
- Terminal editor events replace rather than append, including empty strings. A delayed HTTP reply
  no longer clears text written by the command's own editor effect or edits made while waiting.
  That bug was reproduced with a failing real-browser regression before repair.
- Browser request IDs are journaled in sessionStorage per user/conversation/command/raw args before
  dispatch. Failed/lost replies retain identity across another command, editing and reload. Success
  removes it. At 64 unresolved requests, new operations fail instead of pruning unsafe retry IDs.
- Newline can be the command separator in both parsers; only the separator is removed. Plugin origin
  labels explicitly say Pi extension. Native command precedence stays intact.
- Catalogue guards compare request token AND current conversation/cwd/revision. Old errors/results
  cannot clobber current state, even before the refresh effect runs. Unresolved command-shaped slash
  drafts cannot fall through to ordinary model input while the catalogue loads/fails; absolute paths
  containing another slash still use normal submission.
- Added collision-free prompt-template escaping for the reserved `ext:` namespace. While the bridge
  is on, a template named `ext:portable` appears as `template:ext:portable`; prepend `template:` again
  if an actual template occupies that name. Both plugin and template remain usable. `template:` is
  reserved from plugin short names; plugins remain available through `ext:<actual name>`.
- Added `docs/terminal-extensions.md` and updated map, architecture, feature, extension and index docs.

## Fresh evidence

### Focused checks

- `npm run format`, immediate `node --check` for modified browser JS, `npm run check`, `npm run lint`
  passed. Repeat these after the next product edit.
- Final focused/policy rerun: **105/105 passed**, no skips, after the context/driver/editor/projection
  regressions and final repairs. This includes the browser/manager counts below; do not add them.
  A fresh actual-package rerun afterward also passed **5/5**.
- Latest `test/terminal-ui.test.ts`: **11/11 passed**, real Chromium, desktop and mobile; no skips.
  Covers generic discovery/provenance/raw args/newline, native qualified collisions, widget placement,
  all four forms, empty and nonempty editor replacement, unauthorized/cross-person/cross-conversation
  responses, driver handover, timeout/reload cancellation, catalogue races/loading dispatch, lost reply
    - another draft + reload retry, template collision/actual model context, explicit enable warning.
      Lost-driver cancellation correctly fails the operation with 409 and commits no new effects.
- Latest `test/terminal.test.ts`: **6/6 passed**, including actual-worker comparison against Pocket's
  native context after a branch-point fork, native compaction and reset. Fork inherits only earlier
  extension state. Reset removes old native context but retains extension-owned custom metadata.
- Actual local pi-goal acceptance: **5/5 passed** (no paid provider). In addition to earlier start,
  continuation, registered-tool completion, busy pause/resume, paused restart and token budget cases,
  now verifies active module reload and active server restart pause restored goals. Restart retries
  only the interrupted native request, not autonomous continuation. The test provider honors abort;
  an initial non-abort-aware gate hung shutdown and was corrected in the test, not production code.

### Full-suite and baseline comparison

The unbounded default-concurrency `npm test` run stalled after browser failures and was stopped by
terminating only its identified test process tree. The bounded all-file reruns use canonical test-only
TMPDIR, a temporary worktree node_modules symlink, `--test-concurrency=2 --test-timeout=90000` (120000
in the first bounded run). No tests were filtered or intentionally skipped in these sweeps.

- First bounded sweep: **579/584**, five failures. The extension roster assertion was a legitimate
  feature expectation change; repaired and freshly verified by app tests.
- Later bounded sweep: **586/591**, five failures, no skips/cancellations. It includes the context-race
  and projection tests but predates the later driver test/editor-effect repair. This is not an
  all-green or final acceptance claim.
- Four browser failures reproduce in an untouched `git archive de612d5` temporary copy with the same
  dependencies and bounded runner. Baseline comparison: **53/57**, exact same four failure paths:
    - browser panel test: expected frame HTTP 200, got 204 (`browser.test.ts:692`);
    - desktop composer focus: session-opening timeout;
    - desktop Alt+A PiP focus assertion;
    - status-line launcher timeout.
- The later sweep also hit a subagent held-courier timeout. The single failing test passes on both
  baseline/current, and the entire `test/subagents.test.ts` then passes **33/33 on each**. This supports
  a transient timing failure, not proof that it can never recur; do not silently waive it.

Logs remain in `/tmp`: `terminal-continued-focused.log`, `terminal-continued-ui-final.log`,
`terminal-projection-check.log`, `terminal-continued-goal.log`,
`terminal-continued-full-bounded.log`, `terminal-continued-full-final.log`,
`terminal-baseline-failures.log`, `terminal-current-subagents-full.log`,
`terminal-baseline-subagents-full.log`. Re-run rather than relying on old logs after future changes.

## Independent reviews

Read-only UI/HTTP review requested changes for one HIGH (retry IDs lost across reload/drafts), two
MEDIUMs (newline dispatch and template alias collision), and one LOW (stale catalogue failure).
Parent reproduced the retry gap red-before/green-after and repaired all four with regressions.
Re-review dispositions accept those repairs and report no HIGH/MEDIUM, with one residual LOW context
change/refresh race. Parent repaired that race with a shared current-catalogue guard and regression.
The final editor-effect repair and residual LOW repair are parent-verified, not independently
re-reviewed. Review results were `/tmp/terminal-ui-review-result.md` and
`/tmp/terminal-ui-rereview-result.md`. This is bounded slice review, not final integrated approval.
No final independent verifier has run.

## Previous next-acceptance list (superseded by continuation evidence below)

This was the outstanding list before goal activation. Items 1–4 now have direct acceptance evidence;
item 5 remains open until final integrated re-review, verification and fresh whole-suite comparison:

1. Audit SDK event registrations against events the manager really emits. Unmapped registrations
   must produce explicit diagnostics, not silently succeed. Worker currently accepts more event
   types than production dispatch provides. Review generation retry identity (`message_end` key).
2. Strengthen native policy/lifecycle acceptance: plugin tool argument mutation before real guard/plan
   checks; queued user work/spend/stop during continuation; cwd/trust invalidation and host failure;
   overlapping editor effects attributed to their original requester; bounded hosts/eviction/teardown.
3. Context edit boundaries through the actual worker (fork/compaction/reset now tested); queued active
   autonomous work across restart/outbox crash windows in the integrated manager, not just store tests.
4. Actual pi-goal in the browser/composer path (generic plugin UI + actual-package backend separately
   pass, but that combination is not yet direct evidence).
5. Final full diff audit, integrated independent review/repairs and independent verification. Re-run
   final checks and full suite, preserving/reporting the measured unrelated failures accurately.

No user permission or input is needed for the next engineering slice. Feature status stays incomplete.

## Active-goal continuation: lifecycle and native policy audit

The owner activated a durable goal to complete the acceptance contract. Parent continued with the
next gaps rather than stopping at the browser slice. New evidence supersedes the corresponding
remaining items above (the final audit/review/verification gates remain open):

- Reproduced unmapped static and runtime-added lifecycle registrations succeeding silently. The
  worker now validates registrations against the actual production adapter event set, at load and
  later `pi.on()` calls, with event/source diagnostics. Removed dispatch-only acceptance of events
  the manager never produces. Unsupported registrations fail the host visibly; native chat remains
  a separate path. Supported events are listed in `docs/terminal-extensions.md`.
- Reproduced `message_end` observing only the failed response of a provider retry. Its durable key
  now includes a SHA-256 identity of the terminal response, distinguishing retry/overflow responses
  in one generation while deduplicating repeated delivery of the same response. The production
  regression verifies failed + successful response notifications and only one turn-start/end pair.
- **Reproduced native Plan mode bypass:** enabling the off-by-default terminal module installed its
  hook after plan, so an originally read-only command was mutated into a file write after inspection.
  Regression wrote a forbidden temporary marker before repair. Harness defaults and explicit bridge
  selections now resolve terminal before native hooks while preserving non-terminal relative order.
  Native plan and guard-hook tests pass for default, reversed explicit, and disable/re-enabled
  selections. Only the external guard classifier is stubbed; native hook composition is exercised.
- Extended actual-worker projection evidence with real native omit/replace context-edit boundaries,
  in addition to fork/compaction/reset. SDK projected messages equal Pocket's authoritative context.
- Added explicit actual-package browser acceptance in `test/terminal-goal-ui-acceptance.ts` (not in
  the hermetic default glob). Real Chromium desktop/mobile flow passes discovery, start, busy pause,
  replacement-dialog cancellation, reconnect, resume, continuation, completion via update_goal and
  token-budget wrap-up. Console errors checked; no paid providers or installed-package writes.
- Added manager-level acceptance for eight live busy hosts, actionable refusal of excess work,
  capacity retry, pressure eviction and OS pid checks proving every child exits after disable.
- Added cwd/trust invalidation tests: untrusted project import excluded, trust loads once, distrust
  removes the command and reaps the old host, cwd change replaces/reaps it before further dispatch.
- Added actual process-crash acceptance: an unsafe handler's external marker happens once, its
  uncommitted Pocket append is absent, repeated request ID is interrupted rather than replayed, and
  ordinary native chat rehydrates/recoveries correctly.
- Added overlapping two-person command acceptance: a guest's committed checkpoint prefix delivers
  the pending owner's editor effect to the owner, and the guest's own effect only to the guest;
  effects are delivered once even when the owner handler subsequently finishes.
- Added production manager restart recovery in both committed-before-admission and
  admitted-before-delivery-mark windows. Fault injection freezes later old-process drains so the
  restart, rather than an intervening lifecycle hook, performs repair. State handler executes once,
  one attributed input enters native context, and old command retries return the receipt.
- Actual pi-goal also passes pending-user priority without extra continuation, and spend-blocked
  continuation followed by Stop and a budget increase without restarting autonomous work. Existing
  spend is fully counted before starting that test to isolate outbox admission from native policy
  that separately aborts a run when new usage crosses a budget.

The three lifecycle regressions and policy-bypass regression failed before their product repairs and
passed afterward. These are parent verification results. An independent integrated read-only review
is running via OpenAI Codex `gpt-6-luna` / `xhigh`, output to
`/tmp/terminal-integrated-review1.md`; no final verifier has run. Do not treat this as completed review.

## Integrated review 1 and parent repairs

Independent read-only OpenAI `gpt-6-luna` / `xhigh` review completed: **REQUEST CHANGES**, one HIGH and
four MEDIUM findings (`/tmp/terminal-integrated-review1.md`). Parent resolved each with direct tests:

- Host reservation is now synchronous per conversation; an opening slot owns the child before SDK
  initialization. Identity-checked disposal cancels startup dialogs/IPC and reaps that child before
  removing the slot, without awaiting `session_start`. Concurrent stale-cwd catalogue calls create
  exactly one replacement; disable reaps all recorded pids. A blocked startup dialog is cancelled
  promptly on disable. Capacity/maintenance skip opening hosts rather than await their handlers.
- Passive custom messages have a generic plain-text/image transcript projection and safe fenced
  Markdown export. Browser `isRow` includes the projection, and `display: false` is omitted without
  altering native context. A real browser regression proves hostile HTML stays text and messages
  survive reload. Terminal renderer callbacks are not executed.
- Passive writes no longer require a selected model or available spend. Access, driver, PiP and
  Durable write admission remain enforced. Triggering inputs retain model/image/spend checks.
  The no-model regression failed with the prior 409; projection/export regressions failed because
  stored messages were `other`/absent. They pass with the repairs.
- Exact extension arrays and object removals now include the bridge lifecycle hook first while it
  is enabled. The original selection is retained separately and restored on disable. Tests start
  with arrays lacking terminal and object removals explicitly excluding it, then verify lifecycle
  observations and restored settings, not only an already-selected reversed list.
- Dialog packets carry the original worker deadline. Manager waiters expire/remove themselves even
  if the operation continues on another dialog. Late answers fail 404; cancellation clears timers.
- Terminal shortcuts now fail with explicit load/runtime diagnostics. Flag defaults and generic
  message/entry renderer fallback have actual-worker tests and documented compatibility boundaries.
- Added real periodic idle-maintenance acceptance: advance only the parent test clock, wait for the
  actual child pid to exit, then dispatch on a fresh child and verify the committed counter state
  continues from one to two. No production timeout was shortened.

Verification since repair: typecheck/lint/browser syntax pass. Extended focused run was 154/155:
its sole failure was the newly added final UI test inheriting the preceding test's open Extensions
sheet. Navigating to its session at test start isolates that case. The complete UI suite then passes
**12/12**, with no skip, including generic passive display and reload. Other review regressions
pass together (**8/8**). Fresh combined focus, actual package checks and the full sweep are next;
no final green sweep or verifier result is claimed yet.

## Fresh full sweep / final acceptance additions

- Fresh bounded full sweep: **609/613 passed**, four failures, **zero skips/cancellations**,
  `/tmp/terminal-final-full.log` (canonical test-only TMPDIR, concurrency 2, 90-second test timeout).
  Every bridge suite passed. The four failures have the same browser/focus/launcher paths as the
  earlier baseline findings; a freshly archived `de612d5` comparison is running before labeling them
  unrelated again. The prior subagent held-courier timeout did not recur.
- Parent self-review reproduced selection restoration dropping a native edit made after host boot.
  Base selection tracking now distinguishes its own overlay from subsequent native changes, removes
  only the bridge overlay, and preserves changed non-bridge selections through disable. Red/green
  evidence: `/tmp/terminal-selection-edit-{red,green}.log`. This repair is included in the 613-test sweep.
- Actual-package busy-tool acceptance now also passes: a separate temporary generic plugin tool
  waits on a real tool-context dialog, actual `/goal pause` succeeds concurrently without ending
  that tool, then releasing the tool finishes the native round with no autonomous continuation.
  No product special case or installed-file modification. `/tmp/terminal-goal-tool-busy.log`.
- The last combined actual-package backend/browser run passed **8/8** before adding that ninth case
  (`/tmp/terminal-final-goal.log`). A fresh combined 9-case run remains required.
- Integrated re-review is running via the same OpenAI read-only route, output
  `/tmp/terminal-integrated-review2.md`. No independent verifier has started while that gate is open.

## Integrated review 2: positional and scheduled-admission repairs

Independent integrated re-review (`/tmp/terminal-integrated-review2.md`) accepted all five previous
repairs and independently ran **80 focused tests** plus check/lint/syntax. It requested two additional
MEDIUM repairs. Parent reproduced and fixed both:

1. **SDK ledger order:** append A / send B / append C was A,B,C live but A,C,B after native admission
   and refresh/rehydration. Ordered merge now retains admitted custom-message identities as positional
   fences and never moves later ledger entries before them. A snapshot tail also places unacknowledged
   worker effects after the committed SDK ledger. Direct production-worker regression and four merge
   edge cases cover native interleaving, pending effects, unknown live anchors and dedup/parent links.
2. **Scheduled first-request tools:** idle restart did not register tools before a due schedule's
   request was prepared. The schedule now calls generic terminal preparation before native input
   admission, retains native request identity, and rechecks existing authority/spend after waiting.
   The regression replays the actual provider-facing transcript tool declarations, asserts the tool
   appears in the _first_ prepared request, executes it, and verifies its real native tool result.
   Initial fixture inspection incorrectly read obsolete `context.tools`; it was corrected to
   `getCurrentTools(request.messages)` and the product repair was temporarily reversed/reapplied to
   prove the corrected assertion fails before repair. No weakened assertion or proxy tool list.

Extending scheduled admission exposed two startup cancellation dependencies, also reproduced before
repair: cancelling a due schedule could leave its startup dialog waiting, and server close could
await a startup handler ignoring dialog cancellation until timeout. Preparation now carries the
Durable caller's abort context, checks it before host reservation, and disposes the opening child on
cancellation. `beginClosing` starts child disposal **before** Durable shutdown can await a hook.
Tests use an external safety kill only on the pre-fix hung child; fixed code closes promptly without
that fallback, starts no model work, removes UI and reaps the pid.

Evidence: `/tmp/terminal-review2-red.log`, `/tmp/terminal-scheduled-tools-red.log`,
`/tmp/terminal-schedule-startup-red.log`, `/tmp/terminal-review2-four-green.log`. Fresh combined
focus/policy/schedule/UI run: **172/172 passed**, no skips/cancellations, in
`/tmp/terminal-review3-focused.log`. Format/check/lint/syntax/diff checks pass.

Fresh baseline comparison finished **53/57**, exactly the same four failures as the 609/613 feature
sweep: same assertions, actual/expected values and source lines, not only matching test names.
`/tmp/terminal-final-baseline.log` and `/tmp/terminal-final-baseline-path` retain the disposable baseline
location until final cleanup. Actual installed package backend/browser run subsequently passed
**9/9**, including the added busy-tool pause (`/tmp/terminal-final-goal9.log`), before these two latest
product repairs. Repeat actual package and whole-suite checks after this slice. A targeted independent
re-review of these two integrated repair surfaces is next; final verification is still gated on it.

## Independent review gate cleared; final verification underway

- Review 3 **APPROVED**, zero findings, after independently rerunning eight ordering/scheduled-manager
  regressions. `/tmp/terminal-integrated-review3.md` explicitly resolves both review 2 findings;
  review 2 already accepted all five review 1 repairs. No blocking review findings remain.
- Fresh actual installed-package backend/browser acceptance after the final repairs: **9/9**,
  `/tmp/terminal-review3-goal.log`.
- Fresh full sweep after final repairs: **616/621**, zero skips/cancellations, in
  `/tmp/terminal-review3-full.log`. All bridge suites pass. Four failures match the independently
  reproduced baseline paths. A fifth is a new subagents UI queue timeout at
  `test/subagents-ui.test.ts:879` (`crowded()` waiting for the queue), not the previously seen
  subagent held-courier timeout. Do **not** label this fifth failure baseline merely by association.
- The entire `test/subagents-ui.test.ts` suite subsequently passes **23/23** on current code and
  **23/23** on untouched `de612d5`, with the same canonical TMPDIR and bounded runner:
  `/tmp/terminal-review3-subagents-current.log`, `/tmp/terminal-review3-subagents-baseline.log`.
  This supports a transient timeout but is not a reproduction of the failure on baseline. Another
  all-file run will check whether the timeout recurs; retain all outcomes in final accounting.
- Parent final source audit covered changes and correlated admission/projection/teardown paths.
  A separate read-only independent verifier is being launched only now that review is clear, via
  OpenAI `gpt-6-luna` / `xhigh`; no completion claim is made before its result and the final audit.

## Parent completion checklist (verification still open)

Outcome to prove: a configured, explicitly trusted terminal Pi plugin runs generic commands, tools,
supported lifecycle and portable UI in a per-conversation process, while Durable remains the sole
execution/history/policy authority. The installed goal package is an acceptance consumer, never a
production special case.

| Governing acceptance                               | Artifact and direct evidence                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Discovery, precedence, raw args, retry identity | `terminal-host.test.ts` source/package/resource filters and missing-package no-install cases; `terminal.test.ts` actual submit/qualified aliases/native-table identity; `terminal-ui.test.ts` desktop/mobile provenance, newline args, escaped template expansion and lost-reply + reload journal retry       |
| 2. Trust and requester authority                   | Host import/factory marker exclusion; actual manager cwd/trust replacement; real HTTP viewer, non-driver, cross-person and cross-conversation rejection; UI enable warning and admission-time driver recheck                                                                                                  |
| 3. Isolation and truthful state/context            | Same-cwd separate processes; idle and real restart restoration; actual worker compared with native fork/context-edit/compaction/reset context; ordered ledger/native message and pending-tail regression; exact selections and subsequent native edits preserved                                              |
| 4. Atomicity, recovery, uncertainty                | Store failed-commit rollback and both crash windows; integrated manager restart before admission/after admission-before-mark; once-only model input/requester attribution; interrupted unsafe handler marker once; stop epoch and stale reply suppression                                                     |
| 5. Tools and lifecycle                             | Real dynamic tool execution and native result; mutation-before-native-plan/guard checks; provider retry response identity and once-per-turn boundaries; scheduled first prepared request exposes/executes tool; actual goal busy-model/busy-tool pause, user priority, spend/stop and completion/budget cases |
| 6. Portable UI                                     | Real Chromium desktop/phone suggestions, status/widgets and all four dialogs; empty editor replacement; timeout/late-answer/driver/disconnect/reload behavior; overlapping effects routed once to their original requester; passive plain text/image projection and safe export, display false omitted        |
| 7. Actual installed package                        | Separate `terminal-goal-acceptance.ts` and `terminal-goal-ui-acceptance.ts`, explicit opt-in environment variable, fail rather than silently skip when unavailable; latest combined run 9/9 in `/tmp/terminal-review3-goal.log`                                                                               |
| 8. Bounded lifecycle                               | Protocol and effect/hot-index/outbox limits; eight-busy-host capacity refusal + retry, eviction/idle/disable/crash/cwd/trust pid reaping; concurrent startup reservation; schedule cancellation and shutdown with non-cooperative startup                                                                     |
| 9. Audit and independent gates                     | Review 2 accepted five review 1 repairs; review 3 approved the remaining two and reran eight checks. Parent format/check/lint/syntax/diff pass, focused 172/172. Independent verifier and repeated full-suite accounting remain open; do not equate the checklist with approval                               |

Final coverage audit added explicit host assertions for unsupported model/session/terminal/credential
API actions and unavailable nested tool execution, plus manager assertions for core and native
extension tool-name collisions with provenance and an unchanged native loadout. These are test-only
additions; production code is unchanged since review 3 approval. Their targeted results will be
recorded after execution. Format/check/lint/syntax pass for those additions.

Preservation audit: no existing stored document kind/scope/history/fork setting was modified; only
new terminal-owned kinds were added. PiP/default native registry separation and all non-terminal
relative hook ordering remain. Native `/until`, skills/templates, paths and attachments keep their
existing paths. Production code contains no goal-package branch or alternate provider loop; the SDK
uses disposable in-memory projections and an empty credential store with model access blocked.
Dependency manifests/lockfiles and HEAD `de612d5` are unchanged. Only the feature worktree and
throwaway test/review artifacts were written; no live restart, commit, push, PR or deployment occurred.

### Final test-only coverage correction and repeated sweep

The added capability/collision assertions pass **3/3** in
`/tmp/terminal-final-capability-coverage.log`. The nested-call fixture initially assumed the SDK
throws. Actual `createToolContext().executeTool()` instead returns the documented failed outcome:
`isError: true` with `Nested tool calls are not available in this context`. The fixture now converts
that outcome to a normal tool result, asserts the exact failure and confirms the attempted shell
marker was never created. This is a corrected API-contract assertion, not a product change or a
relaxed expectation that nested execution may succeed. The other seven unsupported-action cases
reject explicitly and native core/extension tool collisions preserve their original loadout.

A concurrent all-file repeat loaded the pre-correction fixture and completed **619/624**, with the
same four baseline failures plus that assertion error. The earlier subagent UI queue timeout did not
recur. All outcomes are retained in `/tmp/terminal-final-repeat-full.log`; it is not a final green
claim. The corrected all-file sweep is running in `/tmp/terminal-final-audited-full.log` and must be
used for final accounting. Production code remains unchanged since independent approval.

## Final verifier finding: stateful fork startup reason

The independent verifier completed a broad acceptance audit and independent runs: host **17/17**,
manager/store/durability/ordering **45/45**, actual package backend/browser **9/9**, plus check/lint/
syntax/diff. Its checklist passed the other acceptance areas, but verdict was **FAIL** for one
concrete lifecycle defect (`/tmp/terminal-final-verifier.md`): inherited terminal state caused a new
fork's `session_start` reason to be `resume` instead of `fork`. The independent disposable probe
observed `newReason: new`, inherited state present, and fork reasons `[new, resume]`.

Parent added a real manager regression recording startup reasons in the generic fixture. It fails
before repair (`/tmp/terminal-fork-reason-red.log`). The minimal product repair changes fallback
precedence so `forkedFrom` wins over the presence of inherited state; explicit eviction/reload reasons
still take precedence over both. Regression passes (`/tmp/terminal-fork-reason-green.log`) and checks
new → fork → idle resume → explicit reload, while preserving counter state. Typecheck/lint pass.
A bounded independent review of this one-line repair is next, followed by verifier closure; the
failed verdict is not being treated as approval or silently replaced with parent evidence.

The corrected pre-fork-repair full sweep completed **620/624**, zero skips/cancellations, in
`/tmp/terminal-final-audited-full.log`. Its four failure signatures match untouched baseline exactly
(after normalizing only checkout paths and durations). The prior transient subagent UI timeout did
not recur. This final source change requires fresh suite checks before completion.

### Fork repair reviewed; independent verifier closure pending

Bounded read-only review of the fork precedence repair **APPROVED**, zero findings:
`/tmp/terminal-fork-review.md`. It checked the relevant four paths and red/green evidence; its own
runtime attempt was prevented by the sandbox's noncanonical temp-directory write restriction, so
its approval is code review, not claimed independent runtime evidence for this regression.
Parent freshly ran the expanded focused/policy/UI/schedule suites **176/176** and actual installed
backend/browser package acceptance **9/9**, in `/tmp/terminal-fork-focused.log` and
`/tmp/terminal-fork-goal.log`. A fresh all-files run after the repair is underway in
`/tmp/terminal-fork-full.log`. The final verifier will close its prior sole finding against current
code and that completed full result; completion is still gated on its verdict.

## Final completion audit

**Outcome: COMPLETE for the supported bridge in this feature worktree. Not committed or deployed.**
The parent checklist above maps all nine governing acceptance areas to actual implementation and
runtime assertions; the independent broad verifier passed those surfaces and found one additional
fork-reason defect. That defect was reproduced, repaired with the minimal precedence change,
independently reviewed and independently verified. No required in-scope finding remains open.

### Independent gates

- Integrated review 1: five findings; integrated review 2 independently accepted all five repairs.
- Integrated review 2: two further positional/scheduled-admission findings; bounded review 3
  **APPROVED** both repairs and their cancellation/shutdown dependencies, zero findings.
- Broad independent verifier: passed its other acceptance checklist rows, **FAIL** for stateful fork
  startup reason. This failed verdict is retained at `/tmp/terminal-final-verifier.md`.
- Fork repair review: **APPROVE**, zero findings (`/tmp/terminal-fork-review.md`). The regression
  proves new/fork/resume/reload reasons and state continuity.
- Independent verifier closure: **PASS — feature acceptance**, directly reran the fork regression,
  inspected the correlated paths, waited for the completed final full sweep and independently
  compared its failure blocks to untouched baseline. `/tmp/terminal-final-verifier-closure.md`.
  Every delegated gate used the prescribed OpenAI `gpt-6-luna` / `xhigh` read-only route.

### Final checks and exact test results

- Formatting, TypeScript check, lint, changed browser JavaScript syntax checks, and `git diff --check`
  pass. Product code did not change after final independent review/verification; the finishing edits
  update documentation and remove verified disposable artifacts only.
- Focused bridge + native policy/schedule/context/export/UI suites: **176/176**, zero skips or
  cancellations. `/tmp/terminal-fork-focused.log`.
- Explicit installed pi-goal backend + desktop/mobile composer acceptance: **9/9**, zero skips or
  cancellations. `/tmp/terminal-fork-goal.log`. Local scripted providers only; installed package
  code was read, never modified. Actual tool/model/native/SDK contexts and rendered browser UI are
  inspected by the assertions, not inferred from counts alone.
- Final all-file suite: **621/625**, **4 failures, 0 skips, 0 cancellations**.
  `/tmp/terminal-fork-full.log`. Same canonical test-only TMPDIR, temporary dependency symlink,
  `--test-concurrency=2 --test-timeout=90000` as documented above.
- Untouched `git archive de612d5` baseline comparison: **53/57** in the four affected browser suites,
  `/tmp/terminal-final-baseline.log`. Final failure blocks match **exactly** after normalizing only
  checkout paths and elapsed durations:
    1. `test/browser.test.ts:692`: panel frame HTTP **204**, expected **200**.
    2. `test/composer-focus-ui.test.ts:154`: session-opening focus timeout.
    3. `test/mobile-ui.test.ts:1611`: Alt+A PiP focus assertion.
    4. `test/status-line-ui.test.ts:315`: launcher timeout.

**The global suite is not green.** These four independently reproduced baseline failures remain;
they are not feature acceptance waivers. The earlier subagent UI queue timeout passed in full
23-test reruns on both current and baseline and did not recur in subsequent final full sweeps. It
was never falsely classified as a reproduced baseline failure. Intermediate failing fixture and
transient-run results remain recorded above rather than hidden.

### Safety, cleanup and remaining owner action

- HEAD remains `de612d5`; all implementation is modified/untracked and uncommitted. No dependency
  manifest/lockfile changes, package installation, paid test provider call, push, PR, deployment,
  owner-data write or live-server restart occurred.
- Removed only the verified feature `node_modules -> ../../node_modules` symlink and the verified
  disposable baseline archive (unlinking its dependency symlink first). The real shared dependency
  directory remains intact. Logs/review evidence in `/tmp` remain; no terminal test workers remain.
- Browser reruns from this worktree require the existing dependency assets to be linked again;
  no dependency installation is needed for this workspace. This was a test environment prerequisite,
  not a committed dependency change.
- Owner-controlled integration/run of this worktree and a normal server restart are separate from
  this verified implementation. Only afterward opt in via Extensions → Terminal extensions and
  accept the OS-privilege warning. Keep the module off by default. Process isolation is not an OS
  sandbox, and the documented unsupported SDK/terminal surfaces remain deliberate limits.
