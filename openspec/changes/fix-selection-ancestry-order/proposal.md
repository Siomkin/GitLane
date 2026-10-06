# Proposal

## Why

Selecting a contiguous run of three or more commits can show "This file also changed in commits between the ones you selected…" for a file that no unselected commit touched. The diff pane stays empty and the file list shows misleading counts. It was reproduced on a real 5-commit linear run (`95d3d51..693c620` on `feature/PIS-1838`), where every commit edits the same file.

The cause is in `ordered_commits`. It hides the walk below `repo.merge_base_many(&ids)`, which has `git merge-base A B C` semantics: the base of the first commit against a hypothetical merge of the rest. That is not the common ancestor of all the picks. For a newest-first linear selection it returns the second-newest pick, the walk never reaches the older picks, and they sort to the end in input order. The scrambled order then makes `touches.rs` report a false gap.

No Jira issue exists yet.

## What Changes

- `ordered_commits` hides below the common ancestor of **all** picks (`merge_base_octopus`) instead of `merge_base_many`.
- Picks with no ancestry between them stay ordered by committer time. The walk's `TIME` sort already does this once every pick is reachable, so no extra fallback code is needed.
- A regression test covers a linear selection of three or more commits passed newest-first.

Process touched: **Rust only** (read side, `src-tauri/src/git/status/selection/`). No IPC, type, or frontend change.

## Non-goals

- UX for a *genuine* gap: the global error banner, an "approximate" marker on the file list, and offering to add the in-between commit. That is a separate follow-up.
- Changing the compose or fail-closed semantics in `compose.rs` / `touches.rs`.
- Reworking merge-commit (first-parent-only) handling.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `review/diff`: adds a requirement that a multi-commit merged diff orders picks by ancestry and never reports a gap for a selection with no unselected commit in between.

## Impact

- Code: `src-tauri/src/git/status/selection/ordering.rs` (a one-call change plus the fallback). Tests go in `src-tauri/src/git/status/tests/selection.rs`, copying `selection_diff_orders_by_ancestry_not_timestamp`.
- No secrets, auth, or IPC surface involved.
- Performance: unchanged. The walk is still bounded by the picks' common ancestor, now the correct one.
