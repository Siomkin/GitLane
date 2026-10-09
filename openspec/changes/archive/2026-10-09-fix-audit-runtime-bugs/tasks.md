# Tasks

## 1. Linux OS openers (A1-1, A1-14)

- [x] 1.1 Remove the `--` argument from `xdg-open` in `src-tauri/src/shell.rs`, `git/write/open_path.rs` and `git/write/reveal.rs`; verify with a unit test that the built Linux argv is `[<absolute path>]` and that `require_absolute` rejects a `-`-prefixed operand.
- [x] 1.2 Make `git/write/reveal.rs::reveal_path` call `crate::shell::reveal` after its worktree guard, keeping the Linux parent-directory rule inside `shell::reveal`; delete reveal.rs's own OS table and verify `cargo test reveal` passes.

## 2. Forge reviewer candidates (A2-1)

- [x] 2.1 Add `rest_repo_path(&GithubRepository)` next to `repo_selector` in `git/forge/cli/`, and use it in `prs/mutations.rs::reviewer_candidates`, `prs/stacks.rs` `list_stacks` and `merge_async_path`; verify with an argument-builder test asserting `repos/octo/app/collaborators?per_page=100` plus `--hostname ghe.example.test:8443`.

## 3. Compare-view renames (A3-1)

- [x] 3.1 Generalise `git/status/working/new_path.rs::renamed_diff` to take the comparison as a parameter, and call it from `git/status/compare.rs::compare_file_diff` when the result looks added; verify with a fixture test that a pure `git mv` between two refs yields a rename with 0/0 lines.

## 4. Terminals (A3-3, A7-1)

- [x] 4.1 Give each PTY session in `src-tauri/src/terminal.rs` one writer thread fed by an `std::sync::mpsc` channel. Spawn it in `spawn`; it exits when the session's `Sender` is dropped on kill or shell exit. Keep `commands/terminal.rs::pty_write` sync: it looks up the `Sender` under the map lock, sends the bytes and returns. No PTY I/O runs on the UI thread or under the lock, and the single consumer keeps keystrokes in order. Keep `pty_write` in `SYNC_BY_DESIGN` with an enqueue-only rationale. Verify with a test that N sequential writes arrive in order, and that `cargo test registration_tests` passes.
- [x] 4.2 Extract `dropRepoTab(path)` in `src/store/repoTab/` and route `closeRepo`, `repoLifecycle/publishSwitch.ts` (replaced source), `repoMissing.ts` (`retireDeadWorktreeTab`, both `fallbackFromRemovedWorktree` branches) and `repoLifecycleActions.ts::locateMissingRepo` through it; verify with a store test that each path calls `closeRepoTerminals` for the dropped path.

## 5. Write-error recovery (A7-2)

- [x] 5.1 Change `repoWriteActions/shared.ts::toastWriteError` to take the captured `owner`, use `owner.path` as `repoPath`, and drop the retry when `!ownerIsCurrent`; update the callers in `staging.ts`, `commits.ts`, `stashes.ts` and `remotes.ts`. Verify with a test: a stage fails in A after switching to B, and the toast's `repoPath` is A with no retry bound.

## 6. Overlays and PR display (A8-1, A4-2, A5-1)

- [x] 6.1 Re-export `overlayOpenDialogs` from `src/store/ui.ts` and derive `navOverlayBlocking` in `action-bar/useActionBarModel.ts` plus `overlayBlocking` in `SettingsModal.tsx` / `RepoSettingsModal.tsx` from it; verify with a test that Escape with `deleteWorktree` open leaves `navOpen` true.
- [x] 6.2 Map review-thread comments through `lib/prs.ts` `uiAuthor`, compare `login` in `ReviewThreads.tsx`, and key `PrMeta.tsx` chips by login; verify with a render test that the PR author `{login:"jdoe",name:"Jane Doe"}` gets the badge on a login-only comment.
- [x] 6.3 Replace the flex/"•" list rendering in `components/ui/Markdown.tsx` with native `list-disc`/`list-decimal` markers; verify with an `<ol>` assertion in `Markdown.test.tsx`.

## 7. Conflicts and small backend fixes (A6-1, A3-4, A3-5, A4-1)

- [x] 7.1 Build `ConflictFileRow.tsx`'s deletion suffix from the operation-aware side names in `conflictWorkspaceModel.ts`; verify with a `ConflictFileRow.test.tsx` case for a rebase with `deletedSide: "ours"`.
- [x] 7.2 Make `acp_agents.rs::load_in` three-state (NotFound → seed + save; other error → seed, no save; Ok → parse); verify with a test that a permission-denied config file is left byte-identical.
- [x] 7.3 Add one `history_result(&Commit)` in `git/read` used by `search.rs` and `range.rs` (committer time, shared `short_oid`), and correct the doc comments in `git/types/graph.rs` and `git/types/refs.rs`; verify that search and range return the same `timestamp`/`shortId` for one commit.
- [x] 7.4 Point `scripts/run-graph-benchmark.ts` at `git::graph::tests::support::benchmark_fixture` with `--exact`, and fail when the output reports `0 passed`; verify with `bun run bench:graph`, which runs one test.

## 8. Integration

- [x] 8.1 Run `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles`, and in `src-tauri` `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, and `cargo test`; all exit 0.
- [ ] 8.2 In `bun run tauri dev`: open a terminal, switch worktree in place, and confirm the old shell is gone; open a PR create dialog on a GitHub repo and confirm reviewers are listed; press Escape in a navigator-raised delete-worktree dialog. — manual, pending
- [ ] 8.3 On a Linux machine or VM with distro xdg-utils: Files panel → Reveal and Open both launch. — manual, pending

## Notes

Deviations from design.md and things a reviewer should know:

- 1.2: Files-panel Reveal now spawns and returns like the onboarding Reveal (one
  `shell::reveal`). A file manager that exits non-zero is no longer reported.
  `shell::reveal` takes `&Path`, and Linux now reveals a file's parent directory
  on both paths. The Linux-only branches were not compiled here (macOS host).
  The new `xdg_open` argv test runs on every platform.
- 3.1: `renamed_diff(file, limit, compare, find)` takes the comparison closure
  and the rename-detection options. The compare view passes `None` (libgit2
  defaults), the same as `compare_refs`, so the list and the pane agree.
- 4.1: This departs from design decision 6 (async + `Arc<Mutex<writer>>`). The
  frontend sends `ptyWrite` without awaiting it, so async writes on separate pool
  threads could reorder keystrokes. Instead, each session has a single writer
  thread fed by an mpsc channel, and `pty_write` stays sync and only enqueues.
  A write that fails now shows up as "not running" on the next call, not on the
  call that failed. design.md decision 6 and proposal.md are updated to match.
- 4.2: `dropRepoTab(path)` covers tab lifetime, unwatch, terminals and terminal
  view. Pruning `openPaths`, tabInfo and recents stays with each caller, because
  the callers differ: `closeRepo` keeps recents. The in-place-switch unwatch moved
  from `sideEffects.ts` into `publishSwitch` (via `dropRepoTab`), so
  `startRepoSideEffects` lost its `opts` parameter.
- 5.1: The signature is `toastWriteError(get, owner, error, retry)`. It keeps
  `get`, which `ownerIsCurrent` needs.
- 6.2: `Reviewer` gained a `login` field so `PrMeta` chips can key by login.
  `uiAuthor` is now exported from `lib/prs.ts`.
- 7.3: `history_result` lives in `git/read/range.rs` with an inline 7-char
  short id. Consolidating the other `short_oid` copies is left to
  dedupe-backend-helpers.
- 7.4: The script fails unless cargo reports `1 passed`, which is stricter than
  failing only on `0 passed`. Verified with `bun run bench:graph` against a
  200-commit generated fixture: 1 passed.
- Rebased onto 9e346c4b (#445/#446). #445's deletions touch nothing here. #446
  rewrote parts of `PrCommentsMarkdown.test.tsx` before this change added its
  author-badge case to the end of that file. The edited regions don't overlap.
