# Tasks

## 1. Rust reads, bounds and subprocesses (A3-6, A3-7, A3-8, A3-9, A3-11, A3-12, A1-18)

- [x] 1.1 Extract `graph::seed_walk` and call it from `git/read/search.rs`; verify that the stash-only-exclusion search test and the graph tests pass.
- [x] 1.2 Route `worktrees/<name>/…` through the commondir arm in `watcher/classification.rs`; verify with a new classification test showing that a sibling worktree's index write is Ignored for a main-checkout tab.
- [x] 1.3 Return `{ commits, truncated }` from `range_commits` across all four IPC layers, and add the §1a row; verify with `cargo test range` and `bunx tsc --noEmit`.
- [x] 1.4 Route the three uncapped whole-file reads through `read_regular_worktree_file_bounded`; verify with a test on an over-cap file.
- [x] 1.5 Run `cursor_cli_models` under the ACP watchdog helper; verify with a test in which a hanging fake CLI is killed at the timeout.
- [x] 1.6 Rewrite `ordered_commits` as one topological walk (or correct its doc if the walk is rejected); verify that the existing ordering tests pass.
- [x] 1.7 Pass the canonical `workdir` to both status probes in `worktree_removal_lease.rs`; verify with `cargo test worktree_removal_lease`.
- [x] 1.8 Implement option (a) for index-lock recovery (Windows: try `fs::remove_file` directly; Linux without `lsof`: hide `stale`) in `write/index_lock.rs`; verify with a `cfg(windows)` test, or a test that `stale` is hidden when no probe exists.

## 2. Store alignment (A7-4, A7-5, A7-6, A7-7, A7-13, A7-14)

- [x] 2.1 Claim the worktree and metadata request lanes before reading, publish through `readRequestIsCurrent`, and extract `followWorkingTree`; verify with a race test where an older snapshot resolves last and does not overwrite.
- [x] 2.2 Run `pull` through `runMaybeConflict`; verify with a store test that a conflicting pull opens the conflict state and refreshes.
- [x] 2.3 Clear `loading` in `agentsCache` save/reset, make `selectCommit` take a `string`, and reset `prSelected`/`prTab` on repo switch; verify each with a store test.

## 3. Feature alignment (A4-4, A5-2, A5-3, A5-4, A5-7, A5-10, A5-12, A6-3, A6-5, A6-15, A6-16, A8-5, A8-11, A8-13, A8-16)

- [x] 3.1 Use `BranchInfo.remote` / `shortName` in `lib/branchSync.ts`; verify with a test for a remote named `team/origin`.
- [x] 3.2 Add `workingChangeCount` to `lib/changeSummary` and use it in the hand-off dialog and the toolbar; verify that a partly staged file counts once.
- [x] 3.3 Export `captureRepoFreshness` from `previewConfirm.ts` for `useRemoveWorktree`, and gate hand-off `start` on `handoffRunning`; verify with the dialogs' tests.
- [x] 3.4 Move the rename/copy rule into `hunkPatchUnavailableReason` and drop `wholeFileOnly` from `ReviewWorkspace`; verify with hunk-action tests for R and C statuses.
- [x] 3.5 Apply the `overlayOpen` guard to the file-filter Escape, restrict the ref-pill "current" mark to branches, and export one advanced-search cap constant; verify with render tests.
- [x] 3.6 Derive the built-in AI-action ids from `DEFAULT_COMMIT_AGENT_MESSAGES`, share `accountMatchesRemoteHost` and `glabUsableFor`, add `useCopyFeedback` (ReviewNotes closes only on success), use `StatusBadge` in the AI-actions popover, and un-nest the WorktreeRow/TerminalTabs buttons; verify each with its component test.
- [x] 3.7 Wire the title-bar Search to the existing `historySearch` slice; verify with a TitleBar test.

- [x] 3.8 Document the out-of-window stash placement exception (A6-2) in `docs/rules/architecture-rules-react.md` and in a comment at the top of `features/graph/historyRows.ts`; verify the doc names `historyRows.ts`.

## 4. One helper per concept (A4-9, A6-4, A6-9, A6-11)

- [x] 4.1 Move `personVisual`/`authorInitials` into `lib/`, route every commit-author avatar through it, and keep one `initials` in `lib/ui.ts`; verify with a test that one author renders identical initials in the graph, inspector and PR views.
- [x] 4.2 Keep one `formatBytes`, one relative-time helper, one `trimTrailingSeparators`, and one diff-tone token module; verify with `bunx tsc --noEmit` and `bun run test`.

## 5. Integration

- [x] 5.1 Run `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles`, `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, and `cargo test`; all exit 0.
- [ ] 5.2 In `bun run tauri dev`: pull with a conflict, hand off with a partly staged file, and open a range of more than 500 commits to see the truncation notice. — manual, pending

## Notes

- 1.3: `range_commits` returns `RangeCommits { commits, truncated }` (a small
  dedicated type rather than reusing `HistorySearchPage`, which carries a
  meaningless `work_truncated`). The cap is testable through
  `range_commits_capped`; the create-PR commits panel shows the count as a floor
  ("500+ commits") plus a "Showing the first N" line.
- 1.4: `read_regular_worktree_file` (unbounded) is deleted; `MAX_WORKTREE_TEXT_BYTES`
  (8 MiB) is the one cap. Blame uses the bounded reader (an over-cap file errors).
  A conflicted file past the cap is reported `binary` (whole-file picker) because a
  cut copy written back would lose its tail. `untracked_file_diff` reads through
  `take(cap)` and sets `truncated` instead of erroring, since the pane can still
  show the head. It is only libgit2's fallback: when libgit2's own workdir diff
  emits hunks for an untracked file, libgit2 still reads the file itself — not
  bounded here.
- 1.5: the bounded runner is `acp::process::output_within(cmd, timeout, max_stdout)`
  (shares the watchdog/reap/process group; the watchdog now takes its timeout).
  `--list-models` gets its own 30 s timeout and 256 KiB stdout cap rather than the
  5-minute turn `TIMEOUT`.
- 1.6: the single walk hides the parents of the picks' merge base, so it covers only
  the span the selection lives in (unrelated histories fall back to a full walk).
- 1.7: `workdir_operand` is shared with `worktrees/lifecycle.rs` (same UTF-8 guard).
- 1.8: the Windows test is `#[cfg(windows)]`, so it compiles and runs only on the
  Windows CI leg; locally the "no probe hides `stale`" test covers option (b).
  `plant_stale_lock` now backdates with `File::set_modified` instead of `touch`.
- 2.1: `openWorktree` reuses `refreshWorktreeScope` (claimed worktree lane,
  reconciler, `followWorkingTree`) instead of a hand-rolled publish, so it also
  re-reads the operation status. `findCheckoutWorktree` claims the metadata lane and
  now also runs `probeDirtyWorktrees` on publish. `followWorkingTree` includes the
  WIP-union reload for both callers (fixes the superseded-graph stale union).
- 3.3: `captureRepoFreshness` shares the one preview token, so a removal preview and
  a reset/delete preview now supersede each other.
- 3.6: `accountMatchesRemoteHost` and `glabUsableFor` are re-exported from
  `@/store/accounts`; `remoteAccountOptions.ts`'s private copy is gone too. The
  hook is `hooks/useCopyFeedback.ts`; `CopyCommand` (the fifth copy) uses it too.
  The AI-actions header tally now uses ChangeCounts' add/del tones.
- 3.7: the title-bar Search switches to the History view and opens the quick
  search (never toggles it shut); it is disabled with no repo open.
- 4.1: `features/graph/commitAgents.ts` moved to `lib/commitAgents.ts` (with its
  test) and now owns `personVisual`; `authorInitials` is gone. `lib/ui.initials(name,
  fallback = "?")` is the one rule (first + last word, splits on `._-`) and also
  backs `lib/prs`, `profileInitials` and the GitHub sign-in chip, so single-word
  labels now read as one letter ("personal" → "P"). Blame, file history and the
  multi-select list render `PersonAvatar` (identity colour + agent icon).
- 4.2: `formatBytes` is `lib/binaryFile`'s; the one relative-time helper is
  `lib/relativeTime.ts` (`relativeTime(sec, { long })`, 30-day month; `lib/prs`
  shares its `ageParts`). `shortAge` (blame gutter "2wk") and onboarding's
  `relativeTime` were left alone. `trimTrailingSeparators` in `lib/paths.ts`
  replaces `trimTrailingSlash`, `normalizeWatchPath` and `graphActions`' local
  `normalize`. `lib/diffTones.ts` holds the add/delete tones; the minimap and ruler
  now use the rail red (`#e0626f`) instead of `#f43f5e`. Theirs-blue `#3b7ff5` stays
  as literal Tailwind classes: they can't read a JS constant, and a CSS token was
  out of scope.
- 5.1: logs are at `scratchpad/apply/c5-*.log`; `cargo fmt` reformatted the new
  Rust before the check passed.
