# Tasks

## 1. Security and P1 behaviour (AUDIT items 8, 3, 4, 5, 9, 10)

- [x] 1.1 Split token extraction in `acp/session/permission.rs` `is_read_only_git` (arrays as-is, strings through `shell_words`, per-element metacharacter check); verify that the argv case from design Decision 1 is rejected and every existing accepted/rejected test is unchanged.
- [x] 1.2 Check `conflict()` and `STALE_SUFFIX` before `hook_hint` in `git/write/classify.rs`; verify with classify tests for the four inputs in AUDIT item 3 plus one genuine husky rejection.
- [x] 1.3 Hash the `Symlink` arm in-process in `git/write/restore_path.rs`; verify with tests for an unchanged, a retargeted and a dangling symlink.
- [x] 1.4 Extract `delete_remote_ref` from `delete_remote_tag`, use it in `delete_remote_branch`, and drop the tracking ref on confirmed absence; verify with a bare-remote test where the branch is already gone.
- [x] 1.5 Sentinel-delimit and time-bound the PATH probe in `shell.rs` (move `output_within` from `acp/process.rs`); verify with a test shell whose rc prints a banner and one that sleeps past the timeout.
- [x] 1.6 Use `blame_buffer` for working-tree blame in `git/status/history.rs`; verify with a test that inserts a line at the top of a committed file.

## 2. Write layer (items 14, 15, 54, 55, 56, 68)

- [x] 2.1 Record a bound remote's credential failure as its `RemoteFailure` in `commands/remotes.rs` fetch and continue with the rest; verify with a two-remote test where one credential fails.
- [x] 2.2 Replace the O(U×T) obstruction scan in `hard_reset_lease/obstructions.rs` with the prefix-set algorithm; verify that the existing obstruction tests pass and a 10⁴×10⁴ synthetic case finishes in under a second.
- [x] 2.3 Share `split_remote_ref`'s longest-remote match with `branches/refs.rs` `remote_tracking_branch`; verify with a `team/fork` remote test.
- [x] 2.4 Give `discard_file` and `discard_all` the hard-reset re-capture policy (unverifiable prefix plus the cause); verify with a test that fails git at discard time.
- [x] 2.5 Build the hard-reset preview's tracked list from `read_porcelain_z`, filter `??` first, then cap; verify with a test that has a git warning on stderr.
- [x] 2.6 Reject `.` as a remote inside `delete_remote_ref`; verify that `delete_remote_branch(".", …)` errors and the local branch survives.

## 3. Read side and graph (items 18, 57, 70, 71)

- [x] 3.1 Add `tooLarge` to `ConflictFileContent` (serde, TS type, schema), read staged conflicts with the same cap, render "too large to merge line by line" in `ConflictEditor.tsx`, and add the §1a row; verify with an over-cap conflict test on both sides.
- [x] 3.2 Fall back to `unborn_branch_name` in `read/recents.rs`; verify with an unborn-repo test.
- [x] 3.3 Seed `commondir()/HEAD` in `graph/layout/build.rs` when the repo is a linked worktree; verify with a detached-main-checkout test.
- [x] 3.4 Read with `take(cap + 1)` in `status/blob.rs` and `status/advanced.rs`, and call `read_header` before `find_blob` in `status/files.rs`; verify with a test that grows a file between the size check and the read.

## 4. Processes and types (items 21, 64, 65, 69, 75)

- [x] 4.1 Reap an exited shell's child after `sessions.remove` in `terminal.rs`; verify with a test that `exit`s a session and checks there is no zombie.
- [x] 4.2 Move `acp_probe`'s `home_dir()` error into the `blocking` closure.
- [x] 4.3 Add `enum ConflictSide` in `git/types/conflicts.rs` and take it in `commands/conflicts.rs`; verify that registration tests and the TS wrapper typecheck.
- [x] 4.4 Add `unmergedCommits` to `DeleteBranchPreview` (four layers) and render from it in `DeleteWorktreeDialog.tsx` instead of matching "Commits ahead"; verify with a dialog test.
- [x] 4.5 Use `std::env::home_dir()` in `signing_keys.rs`.

## 5. Scripts, tests, comments (items 76, 77, 82)

- [x] 5.1 Refuse a non-empty `--output` without the fixture marker in `scripts/generate-graph-fixture.ts`.
- [x] 5.2 Make the updater endpoint tests `include_str!` and parse `tauri.conf.json` / `tauri.beta.conf.json`.
- [x] 5.3 Fix the write-layer and read-side comments listed in AUDIT item 82 (`operands.rs`, the dangling intra-doc links, `staging.rs`, `reset.rs`, `hard_reset_lease.rs`, `types/files.rs`, `selection/compose.rs`, `terminal.rs`); verify with `cargo doc --no-deps` showing no broken intra-doc links.

## 6. Verify

- [x] 6.1 `(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test)`, `bunx tsc --noEmit`, `bun run test`, `bun run sizes`, and `openspec validate harden-git-core --strict` all pass.
- [ ] 6.2 In `bun run tauri dev`: produce a conflict in `.pre-commit-config.yaml` and see the conflict workspace; delete a merged PR's already-deleted remote branch; restore a symlinked file. — manual
