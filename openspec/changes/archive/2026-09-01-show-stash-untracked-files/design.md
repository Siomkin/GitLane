## Context

See `proposal.md` for motivation and `specs/worktrees/stashes/spec.md` for behavior.

Stash selection already reuses the commit inspector: `selectCommit(stash.oid)` → `api.commitFiles` / `api.commitFileDiff`. Those commands are first-parent tree diffs in `git/status/commit.rs`. A git stash commit is a merge:

- `^1` — HEAD at stash time (base)
- `^2` — index snapshot (parent of `^2` is `^1`)
- `^3` — optional untracked tree (`git stash push --include-untracked`)

GitLane's Stash action already stores `^3`. The inspector never reads it. `restore_path_from_commit` checks the named commit's tree, so an untracked stash path would also fail restore even after it appears in the list.

Reads stay libgit2. Writes stay `git checkout` / existing restore helper, aimed at the parent that actually holds the blob.

## Goals / Non-Goals

**Goals:**

- Special-case stash oids inside the existing `commit_files` / `commit_file_diff` (and the per-commit contribution used by union selection) so every current consumer — inspector, stacked review, file diff, multi-select — sees the full snapshot without a new command.
- Detect a stash by membership in `refs/stash` (tiny reflog). Topology alone (`parent(1).parent(0) == parent(0)`) also matches a one-commit feature merge, which would leak second-parent files into a normal merge inspect.
- Point restore at the parent that owns the file-list row (`WIP` when that tree differs from the base, else `^3`, else `^2`).

**Non-Goals:**

- New IPC command or frontend stash-only file loader.
- Changing first-parent merge diffs for normal commits.
- Stash create/apply/pop/drop behavior.
- Splitting the stash file list into staged vs unstaged groups.

## Decisions

### Detect stashes via `refs/stash`, then union three diffs

Treat an oid as a stash when it appears as `id_new` in `refs/stash`. The reflog is small; missing `refs/stash` means not a stash. Then:

1. Diff WIP tree vs `^1` (tracked worktree).
2. Diff `^2` tree vs `^1` (index); add paths not already in (1).
3. If `parent_count >= 3`, diff `^3` vs empty tree; mark those paths `Untracked` (`U`).

Path conflicts: keep the WIP row. `^3` paths that also appear in WIP are ignored (git does not normally store a tracked path on the untracked parent).

Alternative considered: dedicated `stash_files` command. Rejected — the frontend already passes the stash oid to `commit_files`; a second command would duplicate stacked review, selection diffs, and tests.

Alternative considered: detect by parent topology (`parent(1)`'s first parent equals `parent(0)`). Rejected — that is also the shape of `git merge --no-ff` of a one-commit branch, so a normal merge inspect would pick up the wrong parent.

### Keep `commit_file_diff` aligned with the same union

Resolve the file against the same three trees. Untracked (`^3`) diffs as empty → blob (all additions). Index-only uses `^2` vs `^1`. Tracked uses WIP vs `^1`.

If the path is in none of those trees, keep today's empty/default `FileDiff` (same as a bogus path on a normal commit).

### Union selection uses the same per-commit contribution

`selection.rs` currently diffs each picked commit vs first parent. When a picked oid is stash-shaped, that commit's touch set MUST be the stash union above, not first-parent only. Otherwise multi-selecting a stash with other commits would drop the same files the inspector just started showing.

### Restore falls back through stash parents without a new write verb

Keep `restore_path_from_commit(path, commitOid, file)`. If `commitOid` is a stash, restore from the parent that owns the file-list row: WIP when that blob differs from the base (covers tracked edits), else `^3` (untracked), else `^2` when the index blob differs (index-only). Presence in the WIP tree is not enough — an index-only edit still has the HEAD blob in WIP. Use existing `git restore --source=<oid> --worktree`.

Do not stage. Do not apply the whole stash.

### Untracked status is `U`, not `A`

Working-tree lists already use `ChangeStatus::Untracked`. Using `A` would make a stashed new file look like a committed add and hide that apply will recreate an untracked path.

## Risks / Trade-offs

- **[Risk] Topology false-positive on a one-commit merge** → Mitigation: identify stashes from `refs/stash`, not parent shape. A merge constructed with a dropped second-parent file must still list first-parent files only.
- **[Risk] Restore from `^3` overwrites an existing worktree file** → Mitigation: same as today's restore-from-commit (it already replaces worktree contents). No extra prompt in this change.
- **[Risk] Large untracked trees** → Mitigation: same `diff_tree_to_tree` path and line caps as commit diffs; no extra full-tree walk beyond one more parent.

## Migration Plan

No data migration. Existing stashes already have `^3` when created with `-u`. After the read change they start showing those files. Rollback is reverting the read/restore special case.

## Open Questions

None. Ignored files (`stash -a`) stay out of scope.
