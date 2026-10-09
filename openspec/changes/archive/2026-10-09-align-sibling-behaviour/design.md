# Design

## Context

See proposal.md (Why). Each item's evidence (the two siblings, `path:line`, and the
diverging input) is under **Findings**. For each unit, the fix is to adopt the sibling
that is already correct. No new abstractions.

## Goals / Non-Goals

**Goals:** one behaviour per concept, following the sibling that is already right.

**Non-Goals:** see proposal.md.

## Decisions

1. **Adopt the existing sibling.** Examples:
   - `branchSync` adopts `branchRefs.shortName` / `BranchInfo.remote`.
   - `pull` adopts `runMaybeConflict`.
   - The request lanes adopt `readRequestIsCurrent`.
   - The removal flow adopts `previewConfirm`.
   - Author avatars adopt `personVisual`.
   - `formatBytes` comes from `lib/binaryFile`.
   - The AI-actions popover uses `StatusBadge` and `ChangeCounts`.
2. **`range_commits` bound (A3-8).** Return `{ commits, truncated }` and add the §1a
   row to `docs/rules/architecture-rules-rust.md`. IPC four layers: `git/read/range.rs` →
   `commands/history.rs` (or its owning command file) → `git/types` (a new flat
   re-export) → `src/lib/api` wrapper plus schema.
3. **Watcher (A3-7).** Send a leading `worktrees` component through
   `commondir_impact`'s arm (HEAD → Graph, bare dir → Ambiguous, rest → Ignored).
4. **Decided (2026-09-26, recommended default): A1-7, `index.lock` on Windows → option (a).** Option (a): on Windows, try
   `fs::remove_file` directly, since Windows refuses to delete an open file, which is the
   same signal `lsof` gives. Option (b): expose `stale` only when a probe exists, so the
   UI never offers an action that can't work. **Recommendation: (a)**. It is smaller and
   keeps the feature cross-platform. Linux without `lsof` falls back to (b).
5. **Decided (2026-09-26, least-change default): A6-2 → document the exception** in `docs/rules/architecture-rules-react.md` (frontend places only out-of-window stashes, because Rust omits them by design); moving it to Rust stays a possible follow-up. `historyRows.ts` assigns rows and
   lanes to stashes whose base commit is outside the loaded window, using a second
   lane-assignment algorithm. This breaks the "layout in Rust" rule, but Rust
   deliberately leaves those stashes out today. Options: have Rust emit floating stash
   placements, or document the exception in `architecture-rules-react.md`.
6. **Decided (2026-09-26, recommended default): A8-16 → wire it.** Wire it to the existing
   `historySearch` slice (recommended, a one-line handler), or remove the button.
7. **`ordered_commits` (A3-12).** Use one `TOPOLOGICAL | REVERSE` revwalk from the
   selected tips, and rank each selected oid by its position.

Stores touched: `repo` (write actions, selection, refresh lanes) and `ui`
(`prView`, `composer`). No new store. `repoWriteActions/*` and `historyRows.ts` are in the
look band, so run `bun run sizes`.

## Risks / Trade-offs

- [Watcher change misses a real graph change from a sibling worktree] → HEAD writes
  still map to Graph. Add the plain-tab case to the classification tests.
- [Bounded reads truncate a file users expect to see whole] → Use the existing
  named cap and surface `truncated`, as `untracked_file_diff` already does.
- [Unifying author avatars changes some users' initials] → That is intended: one person,
  one avatar. Snapshot tests are updated deliberately.

## Findings

### A1-7 — Stranded `index.lock` recovery can never succeed on Windows, or on Linux without `lsof`
- Priority: P2
- Smell: Speculative Generality / platform hard-coding
- Where: src-tauri/src/git/write/index_lock.rs:74-100, 136-152, 163-182
- Evidence: `lock_file_has_openers` runs `Command::new("lsof")` (its doc says "portable-enough check on macOS"). If the spawn fails, `classify_lock` returns `stale: false` with detail "Failed to check whether the index lock is in use: …", and `remove_index_lock` returns that as an error.
- Consequence: On Windows, a supported target, and on minimal Linux, the GL-335 stranded-lock toast's removal always fails with a tool-not-found message. The feature silently becomes macOS-only.
- Fix: Replace Conditional with Polymorphism, as a `#[cfg]` split. On Windows, attempt `fs::remove_file` directly (Windows refuses to delete an open file, which is the "has openers" signal). Or expose `stale` only when the probe is available, so the UI doesn't offer an action that can't work.
- Confidence: medium

### A1-18 — The worktree-removal lease runs `git status` through the client-supplied path, not the canonical workdir it leases
- Priority: P3
- Smell: Inconsistent boundary (sibling fields disagree on which path is authoritative)
- Where: src-tauri/src/git/write/worktree_removal_lease.rs:166-174, 320 (`dirty_porcelain_capture(worktree_path)`, `ignored_disclosure_count(worktree_path)`) vs the `workdir` doc at 42-47
- Evidence: `capture` canonicalizes `info.path` into `workdir` and documents it as "the *only* path a removal may hand to git … the client-supplied pathname … can be a symlink alias that gets retargeted", yet the status probes that feed `requires_force` and the dirty counts still run against `worktree_path`.
- Consequence: If the alias points somewhere else, the lease hashes and discloses that directory's dirt while identity-hashing the registered one. That is the same alias class the doc says is closed.
- Fix: Pass `workdir.to_str()` (already required at lifecycle.rs:142) to both status probes.
- Confidence: medium

### A3-6 — History-search seed duplicates the graph seed and has already drifted
- Priority: P2
- Smell: Duplicate Code (drifted) + stale Comment
- Where: git/read/search.rs:54-66 (comment "Seed exactly the refs the commit graph walks (see git/graph/layout.rs)"), git/graph/layout/build.rs:60-82
- Evidence: Both push `refs/heads/*`, `refs/remotes/*`, `refs/tags/*` and HEAD by hand. The graph also seeds each linked worktree's detached HEAD (build.rs:72-82); search does not. The comment points at `graph/layout.rs`, which is now a 9-line facade.
- Consequence: The invariant the comment states ("every hit can be revealed by paging the graph") no longer holds in either direction. A commit reachable only from a detached worktree HEAD is in the graph but can never be found by search. The next seed added to the graph will drift the same way.
- Fix: Extract Method. Add `graph::seed_walk(repo, &mut Revwalk)` (the four globs plus the worktree-HEAD loop) and call it from both. The search test at read/search.rs:362-381 (stash-only commits stay excluded) must still pass.
- Confidence: high

### A3-7 — Watcher: a main-checkout tab rebuilds the graph on every sibling-worktree index write
- Priority: P2
- Smell: Sibling implementations that disagree (Duplicate Code across classification arms)
- Where: watcher/classification.rs:161-188 (`classify_path` → `git_metadata_impact`), watcher/classification.rs:192-216 (`commondir_impact`)
- Evidence: For a plain checkout, `resolve_watch_roots` leaves `gitdir`/`commondir` as `None`. An event on `/main/.git/worktrees/other/index` therefore goes `.git` → `git_metadata_impact("worktrees/other/index")`. The first component `worktrees` is not `index`, so the result is `PathImpact::Graph`. The same event reaching a linked-worktree tab goes through `commondir_impact`, which maps `worktrees/<name>/index|COMMIT_EDITMSG|rebase-*` to `Ignored` and only `worktrees/<name>/HEAD` to Graph. The tests cover only the linked-tab arm (classification/tests/worktrees.rs:95-130).
- Consequence: With the main repo and a linked worktree both open, every `git add` or index refresh in the worktree forces a full graph re-fetch (up to 2 000 commits) in the main tab, with no fingerprint check. This is the churn GL-125 set out to remove.
- Fix: Consolidate Conditional Expression. In `git_metadata_impact`, send a leading `worktrees` component through the same arm `commondir_impact` uses (HEAD → Graph, bare dir → Ambiguous, rest → Ignored), and add the plain-tab case to the tests.
- Confidence: high

### A3-8 — `range_commits` caps its list without telling the frontend (rule §1a)
- Priority: P2
- Smell: Rule breach (architecture-rules-rust.md §1a "Every list/blob response declares a bound")
- Where: git/read/range.rs:16-19 (`RANGE_LIMIT = 500`), git/read/range.rs:44-70 (returns bare `Vec<HistorySearchResult>`)
- Evidence: The walk stops at 500 with no `truncated` flag, and the §1a table has no row for it. The rule says a UI "that cannot distinguish 'that's everything' from 'that's the first slice' will silently lie to the user."
- Consequence: A PR dialog whose `base..head` exceeds 500 commits (a mistargeted base is exactly the case the cap exists for) shows 500 commits as if that were the full count.
- Fix: Introduce Parameter Object. Return `HistorySearchPage { results, truncated, work_truncated: false }` (or a small `{commits, truncated}`), and add the §1a row.
- Confidence: high
- Related, lower confidence: `commit_files` (status/commit.rs:25-37), `diff_range` (status/range.rs:20-28), `compare_refs` (status/compare.rs:41-73), `selection_diff` and `stash_files` return unbounded `Vec<FileChange>` and compute a full `Patch` per delta (`diffs_to_changes`, status/diff.rs:218-275). That is a gap in §1a's coverage for path lists rather than a clear breach. Worth deciding explicitly.

### A3-9 — Whole-file worktree reads with no cap, though a bounded reader exists
- Priority: P2
- Smell: Duplicate Code (a cap re-implemented or skipped per call site)
- Where: git/status/working/new_path.rs:107-111 (`untracked_file_diff`: `read_to_end` of the whole file), git/conflicts/content.rs:44-48 (`conflict_file`), git/status/history.rs:158-162 (`blob_text_at` → `read_regular_worktree_file`, unbounded). The bounded helper is git/worktree_fs/reads.rs:24-49 (`read_regular_worktree_file_bounded`); the per-site cap is git/status/working.rs:247-252 (1 MiB probe)
- Evidence: `working_changes` deliberately probes only 1 MiB of an untracked file ("Bound the probe so a huge untracked file can't … balloon memory"). Opening that same file in the diff pane reads all of it into memory and then renders only `DIFF_LINE_LIMIT` lines. Worktree blame and conflict reads work the same way.
- Consequence: Click a multi-GB untracked log or dump in Changes and the whole file is allocated before being cut to 20 000 lines, so a blocking-pool thread holds GBs of RAM. Each read site picks its own policy.
- Fix: Substitute Algorithm. Route all three through `read_regular_worktree_file_bounded` (or `take(cap)`) with a named cap. `untracked_file_diff` already reports `truncated`.
- Confidence: high

### A3-11 — `cursor_cli_models` spawns a CLI with no timeout, outside the ACP watchdog
- Priority: P2
- Smell: Inconsistent sibling implementations (subprocess discipline)
- Where: acp/cursor.rs:28-59 (`cmd.output()`), called from acp.rs:247-260 (`probe`)
- Evidence: Every ACP launch goes through `with_agent`, which has a watchdog (`TIMEOUT`), a process group and capped stderr. The Cursor `--list-models` side call uses a bare `Command::output()`, with no timeout and unbounded stdout.
- Consequence: If `cursor-agent --list-models` hangs (network login prompt, update check), the Settings "Check" probe holds a blocking-pool thread forever, even though the probe itself finished.
- Fix: Extract Method. Reuse the watchdog/reap helper from `acp/process.rs` (a small `run_bounded(cmd, TIMEOUT)`) for this call.
- Confidence: medium

### A3-12 — `ordered_commits` is quadratic in ancestry walks, while the module doc promises linear cost
- Priority: P2
- Smell: Misleading Comment / Long Method cost
- Where: git/status/selection/ordering.rs:29-36 (n² `graph_descendant_of`), git/status/selection.rs:33-35 ("Cost is linear in the selection")
- Evidence: Each `graph_descendant_of` is a merge-base walk, and the loop runs it for every ordered pair.
- Consequence: A selection of "dozens of commits" (the case the doc names) costs thousands of history walks before any diffing starts. The doc steers readers away from the real cost.
- Fix: Substitute Algorithm. Run one revwalk (`TOPOLOGICAL | REVERSE`) from the selected tips and rank each selected oid by its position. At minimum, correct the doc.
- Confidence: medium

### A4-4 — `branchSync.ts` splits remote refs on the first `/`, unlike every sibling helper
- Priority: P2 (wrong result for slash-named remotes)
- Smell: Duplicate Code with divergent semantics (sibling implementations disagree)
- Where: src/lib/branchSync.ts:183-198 (`trackedBranchName` fallback, `remoteTrackingBase`), 200-229 (`defaultPublishTarget`); consumers src/lib/branchSync.ts:115-126, src/features/pull-requests/create-pr/useCreatePrForm.ts:160; correct siblings src/features/pull-requests/create-pr/branchRefs.ts:18-21, src/lib/remoteAccounts.ts:13-20, src/lib/remoteBranches.ts:15-20
- Evidence: `remoteTrackingBase(name)` = text after the first `/`, and `defaultPublishTarget` derives remotes as `b.name.slice(0, b.name.indexOf("/"))` and keeps `upstream.slice(0, slash)` for a stale upstream — all ignoring `BranchInfo.remote`, which the backend resolves precisely because "a remote may contain a slash" (branchRefs.ts:15-17). Input: remote `gh/upstream`, local `feat` tracking `gh/upstream/develop` (upToDate), `gh/upstream/feat` exists → `remoteTrackingBase("gh/upstream/feat")` = `"upstream/feat"` ≠ `"feat"` → `shouldPublishNamesake` true → toolbar offers "Push will publish it" for an already-published branch. With only that remote, `defaultPublishTarget` yields `gh/feat` (remote `gh` does not exist), which is what `useCreatePrForm` pushes to before opening a PR. It also ignores `BranchInfo.pushRemote` that `remoteAccounts.pushRemoteForBranch` honours.
- Consequence: wrong publish prompt and a publish to a nonexistent remote for repos whose remote names contain `/`; three copies of "split a remote ref" must be kept consistent by hand.
- Fix: Extract Function / Substitute Algorithm — use `branchRefs.shortName` (move it to `lib`) and `BranchInfo.remote` in `remoteTrackingBase`/`defaultPublishTarget`, and `remoteNameForUpstream(upstream, remoteNames)` for the stale-upstream case.
- Confidence: medium (logic certain; slash-named remotes are uncommon)

### A4-9 — Near-duplicate helpers that give different answers for the same input
- Priority: P3 (duplication)
- Smell: Duplicate Code / Alternative Classes with Different Interfaces
- Where: avatar initials — src/lib/ui.ts:65-72, src/lib/prs.ts:131-138, src/lib/profiles.ts:48-54, src/components/chrome/overlays/github-signin/GithubSigninDialog.tsx:353-356; trailing-slash normalisation — src/lib/worktrees.ts:9-11 (`trimTrailingSlash`), src/lib/graphActions.ts:61 (local `normalize`, same regex), src/lib/paths.ts:17 (`repoLabel`, single `/`), src/lib/paths.ts:38-44 (`normalizeWatchPath`, single `/` or `\`); basename — src/features/pull-requests/create-pr/prTemplates.ts:87-89 re-implements src/lib/paths.ts:4-6; forge sets — `CREATE_PULL_REQUEST_PROVIDERS` / `supportsCreatingPullRequests` (src/lib/forgeHelp.ts:30-36,57-61, called from actionBarModel.ts:57) hold exactly the same members as `PULL_REQUEST_PROVIDERS` / `supportsPullRequests` (forgeHelp.ts:28,53-55).
- Evidence: `initials("Linus")` is `"L"` in graph/blame/selection lists (lib/ui) but `"LI"` in the PR surface (prs) and identity chips (profiles); blank input gives `""`, `"?"`, `"··"`, `"GH"` respectively. `repoIdentityKey`/`tabIdentity` normalise with `trimTrailingSlash` (strips `///`, never `\`) while the watcher routes with `normalizeWatchPath` (strips one `/` or `\`), so the two keys for the same path can differ.
- Consequence: the same person gets different avatars in different panes; path-keyed state and watcher routing can disagree on an edge-case spelling.
- Fix: Extract Function — one `initials(name, fallback?)` in `lib/ui.ts` used everywhere; one `trimTrailingSeparators` in `lib/paths.ts` used by worktrees/graphActions/tabs/watcher; import `basename` in prTemplates; drop the duplicate create-PR set until the two capabilities actually differ (Inline Function).
- Confidence: high

### A5-2 — The built-in AI-action id list is hard-coded in a third place
- Priority: P2
- Smell: Shotgun Surgery / Duplicate Code (hard-coded list of built-in variants)
- Where: src/features/agents/ai-actions/aiActionDraft.ts:8-19; src/features/agents/ai-actions/aiActions.ts:19-27; src/store/commitAgentMessages.ts:26-57; src-tauri/src/terminal_agents/defaults.rs:36-37
- Evidence: `BUILTIN_AI_ACTION_IDS = [Short, Full, Impl, Release, Review, Test]` restates the ids that `DEFAULT_COMMIT_AGENT_MESSAGES.aiActions` already carries, and that same file's `resetBuiltinAiAction` (line 56) already reads them from that list. Rust keeps its own `BUILTIN_AI_ACTION_IDS: [&str; 6]`.
- Consequence: A new built-in action has to be added in four places: the Rust const, the TS defaults, `AiActionId`, and `BUILTIN_AI_ACTION_IDS`. If the last one is missed, `isBuiltinAiAction` returns false for the new id. The row then shows Delete instead of Reset (AiActionCommandRow.tsx:127/217, CommitAgentMessagesSettings.tsx:77-78), and `removeAiActionCommand` drops it. `migrate_ai_action_commands` (migrations.rs:119-134, which runs on every `load_messages_in`, messages.rs:76) re-adds any missing builtin, so the delete is silently undone on the next load.
- Fix: Replace Magic List with a derived query: `const BUILTIN_AI_ACTION_IDS = DEFAULT_COMMIT_AGENT_MESSAGES.aiActions.map((c) => c.id)`. This also removes the need to export it (it has no importers outside the file).
- Confidence: high

### A5-3 — `accountMatchesRemoteHost` is copied inline in the clone auth model
- Priority: P2
- Smell: Duplicate Code
- Where: src/features/onboarding/flows/clone-flow/useCloneAuthModel.ts:56-68; src/store/accountBindings.ts:115-121 (exported, the canonical copy); src/components/chrome/repo-settings/remotes-panel/remoteAccountOptions.ts:48-54 (a private third copy)
- Evidence: `useCloneAuthModel` filters accounts with `a.host === remoteInfo.credentialHost || (remoteInfo.credentialHost!.startsWith("www.") && a.host === remoteInfo.host)`, and the comment says it should "Mirror accountMatchesRemoteHost". The store already exports that exact predicate, and features may import `store`.
- Consequence: Any change to host matching must touch three named places. If one is missed, the clone form's account picker offers a different account set from the Remotes panel and transport-auth resolution (`store/accounts/transportAuth.ts:293`, `store/accounts.ts:177`) for the same URL.
- Fix: Inline Function → call the shared one: `accounts.filter((a) => accountMatchesRemoteHost(a, remoteInfo))` from `@/store/accountBindings`, and make remoteAccountOptions.ts import it too.
- Confidence: high

### A5-4 — The glab gate is copied in `useCloneAuthModel` so the memo has a dependency
- Priority: P3
- Smell: Duplicate Code (sibling predicates that can drift)
- Where: src/features/onboarding/flows/clone-flow/useCloneAuthModel.ts:41-46; src/store/accounts/transportAuth.ts:320-326
- Evidence: `glabUsable` re-implements `gitlabGlabAuth`'s predicate: gitlab + glab + available + authenticated + `readForgeCredentials()["gitlab"] === undefined`. It also reads localStorage inside a Zustand selector, which runs on every accounts-store change.
- Consequence: If the store's gate is relaxed or narrowed (per-host glab, for example) and this copy is not updated, the form's "Signed in via glab" line disagrees with what `runClone` actually does (runClone.ts:102-105 calls `gitlabGlabAuth` ungated). The comment on the memo promises that "the line can never disagree".
- Fix: Extract Function: move the predicate into one exported `glabUsableFor(forgeAuth)` helper next to `gitlabGlabAuth`. Have both the store action and this selector call it.
- Confidence: medium

### A5-7 — "Copied" feedback is re-implemented four times, and ReviewNotes' Copy ignores failure
- Priority: P3
- Smell: Duplicate Code; sibling implementations disagree
- Where: src/features/agents/AcpAgentFields.tsx:260-282; src/features/agents/SupportedAgentsCard.tsx:169-180; src/features/agents/ai-agent-row/AgentOverflowMenu.tsx:33,52-56,121; src/features/agents/ai-actions/AiActionsDialog.tsx:73,92-96,147-149; src/features/review-notes/ReviewNotes.tsx:70-74 (the divergent sibling); src/components/chrome/settings/accounts-panel/CopyCommand.tsx:10-19 (a fifth, try/catch variant outside the slice)
- Evidence: Four copies of `useState(copied)` + `useEffect(setTimeout(() => setCopied(false), 1_500))` + `navigator.clipboard?.writeText(x).then(() => setCopied(true))`. ReviewNotes instead does `void navigator.clipboard?.writeText(text); dismiss();`, closing the dialog and clearing the user-edited `draft` whether or not the write succeeded (or even ran, when `clipboard` is undefined).
- Consequence: If the clipboard write rejects or is unavailable, the hand-off message the user edited is discarded with nothing copied. Every sibling shows "Copied" only after the write resolves.
- Fix: Extract Function: a `useCopyFeedback()` hook returning `{ copied, copy(text): Promise<boolean> }`, used by the four copies. ReviewNotes should `await copy(text)` and dismiss only on success.
- Confidence: high (duplication); medium (how often ReviewNotes loses data)

### A5-10 — Nested interactive controls in WorktreeRow and TerminalTabs
- Priority: P3
- Smell: sibling implementations disagree (a11y contract)
- Where: src/components/navigation/branch-navigator/rows/WorktreeRow.tsx:36-96; src/features/terminal/TerminalTabs.tsx:30-68; compare src/components/navigation/branch-navigator/rows/BranchRow.tsx:21-25,66-82
- Evidence: BranchRow's doc records that "The pin used to sit inside the row, which nested a real button inside `role="button"`", and that it was fixed by making the controls siblings. WorktreeRow still puts the kebab `<button>` inside its `role="button" tabIndex=0` div, and each terminal tab puts its close `<button>` inside a `role="button"` div. Both need `stopPropagation` on click and keydown to compensate.
- Consequence: Screen readers announce a button inside a button, the problem BranchRow was changed to remove. Any new key handler on the outer row must also remember the `stopPropagation` guards.
- Fix: Apply BranchRow's layout: a presentational wrapper with the reveal/select control and the kebab/close button as siblings. Delete the `stopPropagation` shims.
- Confidence: high

### A5-12 — AI-actions scope popover colours file status differently from the rest of the app
- Priority: P3
- Smell: Alternative Classes with Different Interfaces / Duplicate Code
- Where: src/features/agents/ai-actions/aiActionsView.ts:117-121 (`markClass`), AiActionsHeader.tsx:113-121; compare src/components/ui/StatusBadge.tsx:6-17 and src/components/ui/ChangeCounts.tsx:29-42
- Evidence: `markClass` paints `A` and `U` emerald and everything else amber, and the header hand-renders `+{add} −{del}` in emerald/rose. Every other file list (FileRow, ChangedFileList, CompareView, RevisionRow) uses `StatusBadge` (A = accent, U = neutral, R/C/T = neutral, X = rose) and `ChangeCounts` (accent adds, binary tag).
- Consequence: The same file shows different status colours in the AI-actions popover than in the changes list. Conflicted `X` and renamed `R` read as "modified" amber. Binary files show "+0 −0" instead of the "binary" tag that ChangeCounts exists to show.
- Fix: Inline Function: render `<StatusBadge status={file.status} />` and `<ChangeCounts add del binary />` in the popover, and delete `markClass`.
- Confidence: high

## Considered and skipped
- `runClone.ts:108-157` enteredToken/keychain branch and `clonePassword`/`cloneKeychain` state in useCloneFlow.ts: no screen sets a password any more (only useOnboarding.test.tsx does), so the branch is unreachable from the UI. Three comments call the hide intentional and temporary, so it is not reported as a finding. OnboardingError.tsx:11-12,23-24 still describes the "two-column inputs" that are now hidden.
- Windows separators in `parentDir`/`joinPath` (onboarding.ts:315-327): summary paths come from libgit2's `workdir()`, and libgit2 normalizes to forward slashes internally, so no concrete failure was demonstrated.
- agents↔terminal cross-imports (AgentPromptsSettings → CommitAgentMessagesSettings → AiActionCommandRow; AiAgentRow → agentRowParts): known backlog.
- PR-specific skeletons (`PrListSkeleton`/`PrDetailSkeleton`) in the "domain-free" `components/ui/Skeleton.tsx`: minor layering, only moving code.
- TerminalPanel.tsx:7 comment "Agent buttons (opencode/kimi/claude/codex)" is stale (the defaults are claude/codex plus two disabled presets, and the list is user-configured). Cosmetic.

### A6-2 — Graph layout leaks into the frontend: out-of-window stashes get rows and lanes from a second lane-assignment algorithm
- Priority: P2
- Smell: Architecture boundary leak / Shotgun Surgery (two layout engines)
- Where: src/features/graph/historyRows.ts:78-137 (classification), :145-235 (timestamp interleave and rejoin anchoring), :237-280 (marker-lane assignment via segment-tree occupancy `buildLaneOccupancy`/`maxLaneInSpan`), :313-386; src/features/graph/HistoryWorkspace.tsx:113-119 (`lanesNeeded = max(laneCount, maxMarkerLane+1, wipLane+1)`); Rust counterpart src-tauri/src/git/graph/stashes.rs:26-30 ("Out-of-window stashes are left to the frontend") and graph/layout/build.rs
- Evidence: CLAUDE.md says "Don't put layout logic in the frontend — extend the git/graph.rs facade". Rust lays out in-window stashes as nodes with reserved lanes. For every other stash, `historyRows.ts` computes its row by time interleave (the comment says ">= mirrors the Rust in-window interleave") and its lane as `max(anchorCommit.lane, occupiedLane) + 1` from a frontend range-max tree over graph edges. It then paints a synthetic connector (`StashConnector`). Rust's `laneCount` does not know these lanes, so the workspace re-derives column width from `maxMarkerLane`. Caveat: the out-of-window anchor depends on the frontend's merged row list (the commit list plus the `listStashes` result), so this is not a pure copy of Rust logic. The ownership split is still real.
- Consequence: Any change to stash placement (tie rule at equal timestamps, lane reservation, rejoin policy) has to change `stashes.rs`/`build.rs` and `historyRows.ts` in step. Marker lanes can exceed `graph.laneCount`, so every width consumer must remember `maxMarkerLane`. `GraphLayer` and the stash rows paint from two different lane sources.
- Fix: Move Method. Have the Rust layout also place floating/rejoin stashes (emit them as positioned nodes plus connector edges, or return a `stashPlacements` list with row/lane). `historyRows.ts` then only maps rows, and `laneCount` covers every lane.
- Confidence: medium (the refactor is non-trivial; the leak itself is certain)

### A6-3 — Hunk/line staging policy is split between the container and `hunkActions`: renames and copies silently lose the pill while untracked files get an explained disabled pill
- Priority: P2
- Smell: Divergent Change / Dead Code (unreachable branches)
- Where: src/features/review/ReviewWorkspace.tsx:43-54 (`wholeFileOnly = status R || C` sets `hunkAction = null`), src/features/review/hunkActions.ts:12-21, :40-53
- Evidence: `ReviewWorkspace` nulls `hunkAction` for R/C and write-guarded files, so `UnifiedDiff`/`SplitDiff` render no stage controls and no reason. `hunkPatchUnavailableReason` has a "Renamed files can only be staged as a file" branch (R). It cannot fire through `hunkStaging`, because `hunkAction` is already null for R. Its `source === "commit"` branch is also unreachable, since `hunkStaging` only passes `hunkAction.source` ("unstaged" | "staged"), and the export's only other user is its test. Copies (C) have no reason string at all. By contrast, U and T files keep the pill, disabled with an explanation.
- Consequence: The "whole-file only" rule lives in two files that already disagree. A rename shows nothing, while an untracked file shows "Unavailable" with a reason. Adding a new whole-file-only status means editing both places.
- Fix: Consolidate Conditional Expression. Add R/C to `hunkPatchUnavailableReason`, drop `wholeFileOnly` from `ReviewWorkspace` (keep only the commit/write-guard null), and delete the dead `commit` branch.
- Confidence: high

### A6-4 — Commit-author avatars use three initials algorithms and two colour schemes for the same person
- Priority: P2
- Smell: Duplicate Code / Alternative Classes with Different Interfaces
- Where: src/features/graph/commitAgents.ts:170-182 (`authorInitials`: first and last word, splits on `._-`, identity colour), used by src/features/changes/CommitPeople.tsx:18-26 (`personVisual`), CommitInspector.tsx:214, and commit-row/NodeHoverCard.tsx; src/lib/ui.ts:65-72 (`initials`: first two words, accent background), used by src/features/changes/merged-selection/SelectionCommitList.tsx:21-23, src/features/history-inspect/BlameView.tsx:146-148, src/features/history-inspect/file-history/RevisionInspector.tsx:33-35; plus src/lib/prs.ts:132 and src/components/chrome/overlays/github-signin/GithubSigninDialog.tsx:353 outside the slice
- Evidence: `personVisual`'s doc claims it is "Shared so the graph node, hover card, inspector author block, and trailer rows resolve identity the same way". Blame, file-history and multi-select rows bypass it. Input "Jean Paul Sartre": the graph node and inspector show "JS" on the identity colour, while blame, revision and selection rows show "JP" on `--accent`. Input "john.doe": "JD" versus "J". Known agents (Claude, Dependabot) get their branded icon in one place and plain initials in the other.
- Consequence: The same author looks different across surfaces, and user colour overrides (Settings, Identities) are ignored in three views.
- Fix: Substitute Algorithm. Render every commit-author avatar through `personVisual` (move it and `authorInitials` down to `lib/`), and retire `lib/ui.initials` for commit authors.
- Confidence: high

### A6-5 — The file-filter Escape listener ignores open overlays, unlike its sibling in the history search
- Priority: P3
- Smell: Sibling implementations that disagree
- Where: src/features/changes/file-list/useFileFilter.ts:35-44, versus src/features/graph/HistorySearchBar.tsx:80-89
- Evidence: Both register a document capture-phase `keydown` for Escape. `HistorySearchBar` bails with `overlayOpen(useUi.getState())` and explains why ("Capture also runs ahead of every overlay's own Escape, so this stands down while one is open"). `useFileFilter` has no such guard. Input: filter open with a query, right-click a file (context menu opens), press Esc. The menu closes and the filter closes with its query cleared.
- Consequence: One Esc destroys the user's filter while they meant only to dismiss the menu.
- Fix: Introduce Assertion / Extract Function. Apply the same `overlayOpen` guard, or share one "dismissable field" Escape hook.
- Confidence: medium

### A6-9 — Diff and change colours are scattered literals, with two different "deletion" reds
- Priority: P3
- Smell: Primitive Obsession / Duplicate Code
- Where: src/features/review/DiffBody.tsx:29-32 (ADD_BG/DEL_BG/ADD_RAIL `#2e9e62`/DEL_RAIL `#e0626f`), src/features/review/SplitDiff.tsx:183,190 (same values inlined), src/features/review/ChangeMinimap.tsx:27 (`#2e9e62`/`#f43f5e`), src/features/repo-files/file-workspace/changeMarks.ts:9-11,38-40 (ADD_COLOR, DELETE_CARET `#e0626f`, RULER_ADD, RULER_DEL `#f43f5e`), src/features/changes/changes-workspace/ReviewFileSection.tsx:98-100 (`#2e9e62`); theirs-blue `#3b7ff5` in src/features/conflicts/InlineConflict.tsx, SplitConflict.tsx, ConflictFileRow.tsx, ConflictEditor.tsx and OutputHunk.tsx
- Evidence: `changeMarks.ts:35` says the ruler colours "match the review view's ChangeMinimap", which they do only by hand-copying. Deletion is `#e0626f` on rails and carets but `#f43f5e` on the minimap and ruler. The hunk "changed lines" count is also computed three times: DiffBody.tsx:253, diffRows.ts:50 and :99.
- Consequence: A palette or theme change touches about 8 files, and the two reds already disagree.
- Fix: Replace Magic Number with Symbolic Constant. Add a `diffTones` or `lib/palette` token module imported by every painter.
- Confidence: high

### A6-11 — Duplicated helpers whose outputs disagree: `formatBytes` and relative time
- Priority: P3
- Smell: Duplicate Code
- Where: src/features/repo-files/format.ts:2-6 versus src/lib/binaryFile.ts:8 (`formatBytes`); src/features/history-inspect/inspect.ts:7-25 (`relativeTime`, month = 2629800s), src/features/changes/merged-selection/mergedSelection.ts:45-63 (`relativeCommitDate`, month = 30 days, a comment says it "mirrors lib/prs.relativeSince")
- Evidence: For 15000 bytes the file viewer shows "14.6 KB" while the binary-diff card shows "15 KB". The repo-files version has no GB unit ("2048.0 MB"). The relative-time helpers use different month lengths and formats ("2 days ago" versus "2d ago").
- Consequence: The same byte size and age read differently across panes, and a fix lands in only one copy.
- Fix: Inline Function. Delete `repo-files/format.formatBytes` in favour of `lib/binaryFile.formatBytes`, and keep one `lib` relative-time helper with a format option.
- Confidence: high

### A6-15 — The ref pill marks any ref named like the current branch as "current", including tags
- Priority: P3
- Smell: Primitive Obsession (a name compared without its kind)
- Where: src/features/graph/commit-row/RefCluster.tsx:57, src/features/graph/refCluster.ts:65-72
- Evidence: `current={it.ref.name === currentBranch}` and `rank` compare names only. A tag `v1.2` on the same commit as a checked-out branch `v1.2` gets the accent "current" style and check glyph, and sorts first.
- Consequence: Two pills both claim to be checked out.
- Fix: Introduce a guard clause: require `ref.kind === RefKind.Branch` for `current` and the rank override.
- Confidence: medium

### A6-16 — The advanced-search 200-result cap is spelled three times
- Priority: P3
- Smell: Magic Number / Duplicate Code
- Where: src/features/graph/advanced-history-search/advancedSearchModel.ts:112 (`limit: 200`), AdvancedHistorySearchResults.tsx:34 ("Showing the first 200 matches."), src/features/graph/SearchResultsList.tsx:16 (`MAX_RENDERED_RESULTS = 200`)
- Evidence: The UI label is a literal, not derived from the query limit.
- Consequence: Raising the backend limit leaves a false "first 200" label.
- Fix: Replace Magic Number with Symbolic Constant, exported from `advancedSearchModel` and used by the label.
- Confidence: high

### A7-4 — Two request-lanes are published without claiming them (stale snapshot can overwrite a newer one)
- Priority: P2 (inconsistent / costly to change)
- Smell: Race/staleness after await (lane bypass)
- Where: src/store/repoWriteActions/worktrees.ts:151-158 (`openWorktree` → `set({ changes })`); src/store/repoWriteActions/shared.ts:316-329 (`findCheckoutWorktree` → `set({ worktrees, ... })`); lanes: src/store/repoRequests.ts:102-104
- Evidence: every other writer of `changes` claims `worktreeRequests` and every writer of `worktrees` claims `metadataRequests` and re-checks the lane after its await (repoRefreshActions.ts:83-96, publish.ts:114-158). These two await an IPC (`api.workingChanges` / `api.listWorktrees`) and then `set` guarded only by `ownerIsCurrent` (path + session). A watcher refresh that starts after their read and publishes first is then overwritten by the older snapshot. `openWorktree` additionally publishes `changes` without `reconcileWorktreeState` (no `selectedFile`/`wipSelected`/`operation` reconciliation) and `findCheckoutWorktree` skips `probeDirtyWorktrees`.
- Consequence: working-changes list / worktree list briefly regress to an older state until the next watcher tick; the "every publish goes through the lane + reconciler" invariant has two undocumented holes.
- Fix: Substitute Algorithm — claim `worktreeRequests` / `beginMetadataRequest()` before the read and publish through `readRequestIsCurrent` (and `reconcileWorktreeState` for `changes`), or simply trigger `refresh({scope:"worktree", quiet:true})` instead of publishing directly.
- Confidence: medium

### A7-5 — "Views that follow the working tree" are listed twice and the lists already differ
- Priority: P2 (inconsistent / costly to change)
- Smell: Duplicate Code / Divergent Change
- Where: src/store/repoRefresh/publish.ts:189-200 (full refresh, worktree lane); src/store/repoRefresh/worktreeScope.ts:64-88 (worktree-scope refresh)
- Evidence: both run `onWorkingTreeClean` on `noWip`, `refreshCompare()` when `compare.head === null`, `reconcileFileDiff` unless `selectedFileGone`, `loadRepoFiles()` if loaded, `reloadFileView()` if open. Only worktreeScope calls `reconcileWorkingUnion` (repoSelectionDiff.ts:84). In a full refresh whose graph lane was superseded or failed (publish.ts path at repoRefreshActions.ts:216-236) the worktree lane still publishes new `changes`, but a WIP-inclusive selection union is never re-read, so the merged diff keeps showing pre-edit working-tree content.
- Consequence: adding a new tree-following view means editing two lists; the missing union reconcile is already a stale-diff bug in the superseded-graph path.
- Fix: Extract Method — `followWorkingTree(set, get, path, reconciliation)` called from both; decide once whether the union reload belongs to it.
- Confidence: medium

### A7-6 — `agentsCache` save/reset can strand `loading: true`
- Priority: P3 (polish)
- Smell: Race after await / sibling implementations that disagree
- Where: src/store/agentsCache.ts:41-59 vs 61-75; correct sibling src/store/commitAgentMessages.ts:126-148
- Evidence: `loadAgents` publishes `loading: true` and clears it only `if (lease.isCurrent(token))`. `saveAgents` / `resetAgents` claim the lease but never write `loading`. Save (or model pick via features/agents/useAgentModelPicker.ts:74) while the mount load is in flight → the load loses the lease, never clears `loading`, and nothing else does. `commitAgentMessages` (same design) sets `loading: false` in save/reset.
- Consequence: `loading` stays true until the next `loadAgents` (remount); TerminalAgentsSettings.tsx:104 hides its empty-state while `loading`.
- Fix: Consolidate Duplicate Conditional Fragments — publish `loading: false` from save/reset like commitAgentMessages does.
- Confidence: high

### A7-7 — `pull` bypasses the conflict-aware runner and refreshes nothing on failure
- Priority: P2 (inconsistent / costly to change)
- Smell: Alternative Classes with Different Interfaces (sibling write paths disagree)
- Where: src/store/repoWriteActions/remotes.ts:218-225; compare src/store/repoWriteActions/shared.ts:176-210 (`runMaybeConflict`) and src/store/repoWriteActions/checkout.ts:161-176 (`checkoutRemoteBranch` refreshes on error)
- Evidence: a pull is fetch + merge. When the merge leg stops on conflicts git exits non-zero; `pull` only dismisses progress and `toastWriteError`s — no refresh, no `hadOperation` check. `mergeInto`/`rebaseOnto` route the same outcome through `runMaybeConflict`, which refreshes and reports "resolve conflicts" instead of an error.
- Consequence: a conflicting pull shows a raw git error toast, and the conflict workspace appears only when the watcher fires; behaviour differs from an in-app merge of the same branches.
- Fix: Substitute Algorithm — run the pull body through `runMaybeConflict` (keeping the progress toast/transport mutex around it).
- Confidence: medium

### A7-13 — `selectCommit(null)` publishes the bogus selection `[""]`
- Priority: P3 (API callers will misuse)
- Smell: Speculative Generality / Middle Man
- Where: src/store/repoTypes/actions.ts:83; src/store/repoSelection/commits.ts:75
- Evidence: `selectCommit: async (id) => get().selectCommitMulti(id ?? "", {})`. With `null`, `computeSelection` selects `""`, so the store publishes `selectedCommit: ""`, `selectedCommits: [""]` (then returns at `if (!focusCommit)`), not a cleared selection. The only caller (`revealCommit`, commits.ts:85) passes a string.
- Consequence: the `| null` in the signature invites a caller to "clear" with it and get a phantom selected id that batch ops would send to the backend.
- Fix: Change Signature to `(id: string)`, or Inline Method into `revealCommit`.
- Confidence: high

### A7-14 — `prSelected` / `prTab` survive a repo switch that claims to reset everything repo-bound
- Priority: P3 (polish)
- Smell: Temporary Field / incomplete reset contract
- Where: src/store/ui/prView.ts:11-12,34-39; src/store/ui.ts:151-161,203-240,299-313; consumer src/features/pull-requests/PullRequestDetail.tsx:36
- Evidence: `onRepoSwitched` is documented as "Everything a repository switch invalidates, in one call", and `RepoSwitchReset` lists `createPrHead`/`createPrOpen` but not `prSelected`/`prTab`. `PullRequestDetail` picks `visible.find(p => p.num === prSelected) ?? visible[0]`, so after switching from repo A (viewing #12, Diff tab) to repo B the detail lands on B's unrelated #12 on the Diff tab (eager diff load) instead of the first PR.
- Consequence: cross-repo number collision selects an unrelated PR.
- Fix: add `prSelected: null, prTab: "info"` to `resetPrForm` (and the `RepoSwitchReset` pick) — or record a deliberate exception.
- Confidence: medium

### A8-5 — Hand-off dialog's "N uncommitted changes" double-counts files the toolbar counts once
- Priority: P2 (inconsistent)
- Smell: Duplicate Code (4 inline copies of a count that already has a helper) with divergent semantics
- Where: src/components/chrome/action-bar/WorktreeIndicator.tsx:58-59, src/components/chrome/overlays/menus/WorktreeContextMenu.tsx:99-101, src/components/chrome/useShortcuts.ts:111, src/components/chrome/useShortcuts.ts:155 (vs src/components/chrome/action-bar/useActionBarModel.ts:172 `changeTotal(summarizeChanges(changes))`, src/lib/worktreeHandoff.ts:97-105 `carriedLine`)
- Evidence: The toolbar badge counts distinct paths (`summarizeChanges` ranks by path). The two hand-off entry points pass `staged.length + unstaged.length + conflicted.length` as `sourceChanges`, which `carriedLine` prints verbatim. Input: one file with a staged hunk and an unstaged hunk → toolbar "1", HandoffDialog "2 uncommitted changes … will be carried along".
- Consequence: The dialog overstates what moves; any future change to the counting rule must touch four inline sums.
- Fix: Extract Function `workingChangeCount(changes) = changeTotal(summarizeChanges(changes))` in lib/changeSummary and use it at all four sites (the shortcut guards only need `> 0`, unaffected).
- Confidence: high

### A8-11 — `useRemoveWorktree` re-implements `previewConfirm`'s stale-result guard and diverges on the stale path
- Priority: P3 (duplication)
- Smell: Duplicate Code
- Where: src/components/chrome/overlays/menus/useRemoveWorktree.ts:16-43,76-78; src/components/chrome/overlays/menus/previewConfirm.ts:13-50,81-85
- Evidence: Both keep a module-level `previewToken` and the same `isCurrent = token === previewToken && openIntent.isCurrent(...) && summary.path === repoAtClick && publishedRepoSession.isCurrent(...)` closure plus an upfront `closeOverlays()`. On a stale confirm, `previewConfirm` toasts "Repository changed; preview the action again…", while `useRemoveWorktree` returns silently. The two tokens are independent, so a delete-branch preview and a remove-worktree preview don't supersede each other.
- Consequence: The same safety rule lives twice with different user feedback; hardening one (as GL-42 did) leaves the other behind.
- Fix: Extract Function — export a `captureRepoFreshness()` (token + intent + session + path) from previewConfirm.ts and use it in both, including the stale toast.
- Confidence: high

### A8-13 — Hand-off dialog handles "a previous run is still going" differently from its sibling flows
- Priority: P3 (inconsistent)
- Smell: Alternative Classes with Different Interfaces
- Where: src/components/chrome/overlays/handoff/useHandoffRun.ts:41-86, src/components/chrome/overlays/handoff/HandoffDialog.tsx:182-189 (vs src/components/chrome/overlays/delete-worktree/useDeleteWorktreeRun.ts:48, DeleteWorktreeDialog.tsx:179,185-189; src/components/chrome/overlays/remove-detached/useRemoveDetachedRun.ts:53, RemoveDetachedDialog.tsx:190,197-201)
- Evidence: Delete-worktree and remove-detached check their store latch (`deleteWorktreeRunning` / `removeDetachedRunning`) in `start()` and disable the button with "Another … is still finishing". `handoffRunning` exists with the same semantics (store/ui/dialogs.ts:270-275) but useHandoffRun never reads it; a reopened dialog lets the user press "Hand off", the store's `loading` guard throws "Another operation is in progress" (store/repoWriteActions/worktrees.ts:50), and the dialog lands on the "Hand-off failed" screen.
- Consequence: Same situation, three flows, two behaviours; the handoff one reports an error for a non-failure.
- Fix: Consolidate Conditional — gate `start` and the button on `handoffRunning` exactly like the two siblings.
- Confidence: medium

### A8-16 — Title-bar "Search" button does nothing
- Priority: P2 (misleading UI)
- Smell: Dead Code (inert control)
- Where: src/components/chrome/TitleBar.tsx:46-52
- Evidence: A focusable `<button title="Search" aria-label="Search">` with no `onClick`, no ref, no parent handler; nothing else in the slice wires it.
- Consequence: Users (and screen readers) are offered a control that has no effect.
- Fix: Remove Dead Code, or wire it to the existing history-search slice.
- Confidence: high
