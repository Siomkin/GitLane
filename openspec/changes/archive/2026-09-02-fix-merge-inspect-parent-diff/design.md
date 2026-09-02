## Context

See proposal.md for why. Specs: `review/diff`. Reproduced on a real merge commit whose parent 0 is the feature tip and parent 1 the mainline tip: first-parent ~120 files, second-parent / `mainline...HEAD` 29 files.

`commit_files` / `commit_file_diff` always use parent 0 (`git/status/commit.rs`). The inspector metadata prints only `commit.parents[0]`. `diff_range` / `diff_range_file` already diff any two commit-ishes. Stash oids must keep the stash union (`worktrees/stashes`).

Engine: libgit2 reads. Zustand: `useRepo` only. No new native/JS dependency.

## Goals / Non-Goals

**Goals:**

- Parent picker on non-stash merges; default first parent.
- Non-first-parent file list and file diff reuse `diff_range` / `diff_range_file` (`parentOid` → merge oid).
- Label parents with short sha + a matching local/remote ref when one exists.

**Non-Goals:**

- New IPC, unless wiring `parent_index` onto `commit_files` is clearly smaller than two call sites.
- Heuristic default flip for “Merged X into Y”.
- Combined multi-parent union (non-stash).

## Decisions

### 1. Reuse range reads; do not change `commit_files` default

Selected parent index lives on inspect state next to `selectedCommit` (reset to 0 whenever the selected oid changes).

- Index 0: keep `commitFiles` / `commitFileDiff` so stashes and today’s first-parent tests stay on one path.
- Index > 0: `diffRange(parentOid, mergeOid)` and `diffRangeFile(...)` for the file list and hunks. `selectFile(..., "commit")` must pass the active range into the file-diff loader so hunks match the list.

Alternative considered: add `parent_index` to `commit_files`. Rejected for this slice — range IPC already exists and stash detection stays isolated.

### 2. UI in CommitInspector, not a new overlay

Replace the single “parent” sha with a compact control when `parents.length > 1` and the row is not a stash. Clicking a parent sets the inspect index and reloads files. `CommitInspector.tsx` is in the 201–400 look band — keep picker markup small; put load logic in the existing selection actions (`repoSelection/commits.ts`).

Ref names: scan `branches` (and tags if cheap) for `oid === parent`. Prefer a local branch name, else the remote-tracking name (`develop` / `origin/develop`). If none, short sha only.

### 3. Stacked review / restore stay on the active parent

“Review all” from the inspector must use the same tree pair as the visible list (commit review for parent 0, range review `parentN..oid` otherwise — `compareRange` already exists). Restore-from-commit stays first-parent/stash as today; do not restore against a second parent in this slice (non-goal unless a test already requires it).

## Risks / Trade-offs

- [Users still see ~120 files until they click the other parent] → Mitigation: both parents are visible with counts or ref names; default stays git-show so feature-into-develop merges do not surprise. Heuristic auto-flip is a follow-up.
- [Range diff vs `commit_files` rename/copy options drift] → Mitigation: same `DiffOptions` in `range.rs` and `commit.rs` today; do not diverge. Parent 0 stays on `commit_files`.
- [Stash false-positive] → Mitigation: hide picker when `commit.stash` is set / `is_stash_oid`; stash spec unchanged.

## Migration Plan

One GitLane release. No on-disk migration. Rollback is revert.

## Open Questions

None.
