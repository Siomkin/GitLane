## Why

Selecting a “merge mainline into my feature” commit in a large repository lists ~120 changed files — the first-parent diff, i.e. everything the mainline brought in. The branch’s real scope is the other parent: 29 files vs the mainline (`git diff mainline...HEAD`). GitLane’s inspector only diffs vs parent 0 and only displays that parent, so a “merge mainline into my feature” commit looks like a 120-file change set.

No Jira key (GL-xx) for this change.

## What Changes

- For a merge commit (two or more parents, not a stash), the inspector MUST list every parent and let the user pick which parent the file list and per-file diff are against.
- Default remains first parent (`git show` / today’s `commit_files`) so ordinary merges of a feature into `develop` stay a small, first-parent list.
- Switching to another parent MUST reload the file list and diffs as `parentN..merge` (same trees as `git diff parentN merge`).
- Parent labels SHOULD include a short sha and, when a known ref points at that parent, the ref name (so `develop` vs the feature tip is obvious).
- Stash commits keep the existing stash-union file list and MUST NOT grow this parent picker.

## Capabilities

### New Capabilities

- `review/diff`: Inspecting a merge commit can show the file list against any parent, not only the first.

### Modified Capabilities

- None. `worktrees/stashes` already requires non-stash commits, including merges, to default to first-parent; this change keeps that default and adds a switch.

## Impact

- Frontend: `CommitInspector` parent metadata (today only `parents[0]`); commit file-list load in `repoSelection/commits.ts` / `repoLifecycleActions.ts`; per-file `commitFileDiff` vs `diffRangeFile` when a non-first parent is selected.
- Reads: libgit2. Reuse existing `diff_range` / `diff_range_file` for the non-first-parent view. First parent stays on `commit_files` / `commit_file_diff` (stash path). No new command unless a single `parent_index` argument proves cleaner.
- Zustand: `useRepo` — extra inspect-against-parent state on the selected merge, not a new store. Tokens never enter JS.
- Tests: Rust range fixtures already cover two-commit diffs; frontend inspector tests for a two-parent commit showing both parents and swapping the file list (120 vs 29 — a large first-parent set vs the feature’s own scope).

## Non-goals

- Changing the default away from first parent.
- Combined / three-parent “union” diffs of a merge (except stashes, already specified).
- Auto-detecting “merged develop into feature” and flipping the default.
- PR file lists on the forge (those already use the provider’s three-dot compare).
- Rebase / force-push (that is `fix-remote-feature-rebase`).
