## 1. Stash-aware commit file list and per-file diff

- [x] 1.1 Add a stash detector (`refs/stash` reflog membership) in `src-tauri/src/git/status/stash.rs` and verify a unit test accepts a `git stash push --include-untracked` commit and rejects a normal two-parent merge
- [x] 1.2 Make `commit_files` union WIP vs `^1`, index-only vs `^1`, and `^3` vs empty tree (mark `^3` as `Untracked`; prefer WIP on path overlap) and verify tests cover: tracked+untracked stash lists both with `U` on the untracked path; stash without `^3` stays tracked-only; index-only path appears; a merge commit still lists first-parent files only
- [x] 1.3 Make `commit_file_diff` resolve the same tree as the file list (`WIP`, else `^3` as empty→blob, else `^2`) and verify a test that an untracked stash path diffs as an addition of the stored contents

## 2. Union selection and restore

- [x] 2.1 When `selection_diff` / `selection_diff_file` walk a stash-shaped oid, use the stash union as that commit's contribution instead of first-parent only, and verify a test that a selection containing such a stash includes its untracked path
- [x] 2.2 Point `restore_path_from_commit` and `worktree_differs_from_commit` at the parent that holds the blob (`WIP`, else `^3`, else `^2`) and verify tests that restoring an untracked stash path writes the file without staging, a tracked stash path still restores worktree-only, and a missing path on a normal commit still errors

## 3. Frontend consumers and lockstep

- [x] 3.1 Confirm inspector / stacked review keep calling `commit_files` and `commit_file_diff` (no new command) and extend `CommitInspector` / stacked-review tests so a stash file list with a `U` row renders in Changed files and stacked review; verify those vitest files pass
- [x] 3.2 Run `bunx tsc --noEmit`, `cargo test` for the touched status/restore suites, `bun test` on the touched frontend files, and `openspec validate show-stash-untracked-files --store gitlane`, and verify they pass
