## Why

Selecting a stash shows only the tracked worktree diff (`stash` vs first parent). Files GitLane actually stored with `--include-untracked` live on the optional third parent and never appear in the inspector, stacked review, or per-file diff — so a stash that captured both a modified file and a new untracked file looks like it contains only the modified one.

## What Changes

- When inspecting a stash, show every path that `stash apply` / `stash pop` would restore: tracked worktree changes, index-only changes, and untracked files from the third parent.
- Show those untracked paths with the same untracked (`U`) treatment as the working-tree file list, and load their diffs.
- Keep ordinary commit inspection first-parent-only. Stash create already uses `--include-untracked`; this change does not alter push/pop/drop.

## Capabilities

### New Capabilities

- `worktrees/stashes`: Inspecting a stash lists and diffs the full snapshot git stored (tracked + untracked + index-only), not only the first-parent tree diff.

### Modified Capabilities

- None. There is no main spec for this capability yet.

## Impact

- Read path: `commit_files` / `commit_file_diff` in `src-tauri/src/git/status/commit.rs` (and the union-selection diffs that reuse first-parent-per-commit).
- Restore: `restore_path_from_commit` cannot check out an untracked stash path from the WIP tree; it must read the third-parent blob when that is the file's source.
- Frontend: `CommitInspector`, stacked review, and commit file diffs keep the same IPC commands; they start receiving the extra files. No new command unless design proves a dedicated stash-files API is cleaner.
- Tests: Rust stash-shaped commit fixtures; inspector already has a stash selection case that will need a two-file list.

## Non-goals

- Changing stash create (`git stash push --include-untracked` stays).
- Showing ignored files (`stash -a`).
- A separate staged/unstaged grouping in the stash inspector (one changed-files list, like a commit).
- Rewriting how stashes sit on the graph.
