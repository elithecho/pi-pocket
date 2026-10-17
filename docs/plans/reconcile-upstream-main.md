# Upstream main reconciliation — trial report

This report records the trial before integration into main. The user subsequently authorized merging it; Git history records that integration. References below to an uncommitted candidate and untouched main describe the trial checkpoint, not the later integration state.

## Result and effort

A resolved, uncommitted integration candidate lives on branch **`reconcile-upstream-main`**, in:

`/Users/elijah/Workspace/pi-pocket/.worktrees/reconcile-upstream-main`

This is a **moderate integration, not a rewrite**. Git reported 13 conflicted paths, but the more important work was preserving behavior that Git silently removed in clean merges. The trial implementation is complete; final test/review results are recorded below. Budget a further focused validation session before replacing the running checkout, particularly for real terminal plugins and drop-ins. A rough allowance is a few hours to half a day, depending on those integrations and any remaining test failures; this is not a measured delivery promise.

The running main checkout, user data, external extensions, and external themes have not been changed. Nothing has been committed, pushed, published, or deployed. The branch reference still points at the local base until an authorized merge commit is made; the reconciled candidate is the staged working tree with a pending merge.

## Compared snapshots

- Local main: `8874dab` (upstream 0.14 beta.7 already integrated, with local workflows).
- TannerMidd/pi-pocket main fetched on 2026-10-17: `e5456a832d47e7154faf04320dd7602ae5051bf7` (0.14.0 stable).
- Reachability: 30 local-only commits, 218 upstream-only commits. These counts include merges; they are not feature or effort counts.
- There are multiple merge bases. `git merge-tree` and the real merge both used Git's recursive merge-base handling; a single three-dot diff is not an authoritative preservation audit here.
- Initial Git conflicts: four docs, three server files, five web files, and one obsolete upstream test (13 total).

## What is yours and stays

| Area                         | Preserved behavior                                                                                                                                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Teams                  | Your `linkedChats` service, `team` tool and guidance; ordinary independent chats; optional exact model/thinking overrides; inherited defaults; steer-default sends; peers starting peers; no upstream one-level, session-count, relay or source-thinking caps.              |
| Teams privacy and durability | Opaque local peer handles, audience-filtered metadata, independent budgets and lifecycle, stable stored document names/receipts and replay behavior.                                                                                                                        |
| Terminal extensions          | Process-isolated SDK bridge, trust filtering, native plan/guard ordering, command dispatch, large-history chunk transport, durable state/outbox/receipts, failure quarantine and optional/required policies. All terminal source files remain byte-identical to local main. |
| PiP and Settings             | Rail Settings entry, PiP-specific model controls and private configure path, separate from the current ordinary chat.                                                                                                                                                       |
| Composer                     | Queue-to-steer promotion, keyboard promotion without clearing the draft, Ctrl+W word deletion and your existing regression coverage.                                                                                                                                        |
| Favorites                    | SQLite-synced favorites, favorites-first New session dialog, loading-vs-empty distinction, home-rooted explicit browsing, shortcuts/worktree option, and palette launch actions.                                                                                            |
| Model picker                 | Scoped/all controls, original keyboard focus flow, touch sizing, PiP picker, and default selection behavior. Upstream's real out-of-scope search improvement is retained; a search matching no model does not unnecessarily change scope.                                   |
| App architecture             | Build-free Preact/ES modules served directly, Pi Durable storage, extension boundaries, terminal child processes; no framework migration.                                                                                                                                   |

Some contributions already exist upstream: the basic Agent Teams feature, favorite-folder palette actions, and scoped/all model picker + Refresh models. Upstream has revised these, so keeping a feature name alone would not preserve your exact implementation or policy.

The audit at `scripts/reconcile-audit.mjs` checks the two pinned trees against the candidate. **All 43 fork-only files are retained.** Forty remain byte-identical; the only changed fork-only files are three tests: the new independent-budget regression, and two existing UI suites updated for upstream's `New session in …` label. No file present in local main is deleted.

## What you gain from upstream

- Folder-based CSS/layout themes, including **Pocket** and **Lantern**, with independent palettes, custom fonts/images, Duplicate/Edit with Pi, live stylesheet updates and documented stable tokens/parts.
- Appearance's conversation Width setting and wider code/table handling.
- Themes in the gallery, stronger file/import/CSS checks, update previews and recovery hardening.
- Public extension type declarations, reference validation and a separate documentation site.
- Security/permission fixes, including plan-mode tool-hint handling and the `rg --hostname-bin` refusal.
- Attachment-only message rendering/edit/retry/export fixes; improvements to PiP attachments/resizing, focus, scrims, model search, folder navigation and read/unread handling.

The root app still has no build. The new Astro documentation site is separate. No packages were installed: the worktree links the existing checkout's dependencies. Upstream adds a docs-site manifest/lockfile, but its site build was not performed.

## Non-obvious merge decisions

1. **Independent Teams budgets.** Upstream's clean app merge introduced `teamRoot`/`budgetSpent` calls and linked-family refreshes. Removed those rather than restoring family budgets. A new test records only peer spend, proves source admission and displayed budget/spend remain independent, and proves the peer's own budget still blocks it.
2. **Retained host capability.** Upstream removed `app.host` as test-only. Your terminal manager uses it in production, so its assignment and field were restored without changing the terminal bridge.
3. **Favorites-first was silently deleted.** Upstream's limited palette PR removed the chooser, loading flag and styles without a conflict. Restored all three while retaining the newer missing-favorite removal and keyboard-focus fixes. Restored the dedicated favorites UI suite that upstream deleted.
4. **Model picker and PiP.** Combined upstream markup/accessibility/IME/search work with your PiP route and original Tab focus progression; avoided the duplicated keyboard handlers produced by the textual merge.
5. **One messaging service, not two.** Kept `linkedChats` as the sole implementation. Updated new public declarations, bidirectional type checks and reference docs to describe its actual methods. Did not add a fake upstream `linkedSessions` alias. Consequently a new extension requiring upstream's incompatible `host.linkedSessions` API needs a port; ordinary extension APIs remain available.
6. **Obsolete upstream test.** Kept the fork's deletion of `linked-sessions.test.ts`, whose API and shared-budget assertion are incompatible with your service. Existing linked-chat coverage stays, with an explicit opposite-budget regression.
7. **Small test portability repair.** Upstream's new types-link test compared a canonical macOS `/private/var` path against `/var`; it now compares real paths on both sides. The full verification run also uses a canonical temporary directory so existing PiP/repository path fixtures are not mistaken for product regressions.

## Verification

Final test status: **PARTIAL — 493/495 passed in the complete controlled run.** Two timing-dependent checks failed: drop-in hot-reload detection and nested-subagent report requeueing. Both pass when run separately on this exact candidate and on untouched upstream, but that does not erase the full-suite failures. The candidate is not certified production-ready. Independent read-only preservation review returned **PASS**, with zero findings across 24 correlated paths; the reviewer explicitly did not certify the full suite as green. The reviewed code tree was `3d9eeb3c6ecdfc5ed8c18a3a2c6a91a9a6986817`; only this report changed afterward.

Already passed on the candidate:

- `npm run format`, `npm run check` (TypeScript, public type file and reference checks), `npm run lint`.
- `node --check` for all 38 changed web JavaScript modules.
- Preservation audit and staged diff whitespace/conflict checks.
- Final post-review focused run: **37/37 passed** across Teams core/privacy/routing, linked-chat desktop/mobile/tree UI, queue-to-steer, composer Ctrl+W, PiP model settings, model scope keyboard/touch, and favorites-first/palette UI. Pi-session/favorites UI also passed separately (6/6). All terminal suites passed in the full run; neither remaining full-suite failure was in terminal coverage.
- Manual throwaway-app smoke: Lantern applied; Settings retained PiP model + Refresh models; PiP-specific model picker opened; favorites-first dialog rendered at 390×844 with no console errors.

Evidence retained outside product code:

- `/tmp/pi-pocket-reconcile-merge-tree.txt`: initial conflicts.
- `/tmp/pi-pocket-reconcile-budget-red.log` and `-budget-green.log`: budget integration regression investigation (the final full run includes the corrected test).
- `/tmp/pi-pocket-reconcile-check-final.log`, `-lint-final.log`, `-audit.json`.
- `/tmp/pi-pocket-reconcile-tests-final.log`: initial complete run, 479/495 passed before the preservation repairs; failures are retained, not hidden.
- `/tmp/pi-pocket-reconcile-tests-verified.log`: final controlled full suite, 493 passed / 2 failed, with concurrency 4 and canonical TMPDIR.
- `/tmp/pi-pocket-reconcile-final-focused.log`: post-review focused verification, 37/37 passed.
- `/tmp/pi-pocket-reconcile-upstream-main-remaining.log` and `/tmp/pi-pocket-reconcile-upstream-reference-remaining.log`: the two remaining cases pass on both the candidate and untouched upstream when isolated (2/2 on each). These are diagnostic comparisons, not a substitute for a clean full run.
- `/tmp/pi-pocket-reconcile-upstream-baseline.log`, `-fork-baseline.log`, `-loader-main-repeat.log`: loader/startup comparison runs. All passed on isolated comparisons, but earlier loaded runs had watcher/startup timeouts; those failures are not treated as disproven by a green retry.
- `/tmp/pi-pocket-reconcile-worker/events.jsonl`: persistent read-only Pi Critic/review output. Plan round 1 requested an independent-budget behavioral check; revised plan approved. Subsequent code review returned PASS, zero findings in the bounded preservation scope. The separate reviewer used `openai/gpt-6-luna` with xhigh thinking via persistent Pi RPC. No intercom hook was available; RPC settled-output events and retained logs were used.

## Not certified / next step

- Your actual enabled plugins, provider sign-ins, live database, and drop-ins/themes outside Git were not loaded or modified. Passing scripted-model tests is not certification of every external extension.
- Documentation-site build, Nix checks, and a production restart were not run.
- A clean upstream-reference worktree was retained at `.worktrees/reconcile-upstream-reference` for baseline comparisons; it is not the integration candidate.
- Before committing/merging: review this preservation inventory against any personal features not captured by repository tests, settle the two full-suite timing failures, then test a disposable copy with the real extensions you care about. Commit/merge/restart remains a separate authorized action.

To inspect without switching the running checkout:

```sh
cd /Users/elijah/Workspace/pi-pocket/.worktrees/reconcile-upstream-main
git diff --cached 8874dab --stat       # what upstream adds to your fork
git diff --cached e5456a8 --stat       # what remains different from upstream
node scripts/reconcile-audit.mjs
```
