# Design

## Context

The evidence for each item is in `AUDIT.md`. Items owned here: 3, 4, 5, 8, 9, 10, 14, 15,
16, 17, 18, 19, 21, 54, 55, 56, 57, 61, 62, 64, 65, 68, 69, 70, 71, 73, 75, 76, 77, 78, and
the write-layer and read-side part of 82. Every edit stays inside its engine: git CLI for
writes, libgit2 for reads.

## Goals / Non-Goals

**Goals:** each item's behaviour matches its sibling or its documented contract, with a
test that fails today.

**Non-Goals:** lease semantics beyond item 55's wording, rename-detection policy (A3-22),
and the forge.

## Decisions

1. **ACP tokens (item 8).** `is_read_only_git` gets its tokens from one function: a string
   `command` goes through `shell_words::split`, while an array `command`/`args` is used
   element for element. The metacharacter check runs on each element. The rest of the walk
   (program, globals, subcommand, denylist) is shared and unchanged. The regression case
   `["git","log","--format='","--output=/tmp/pwn","--grep='"]` joins the rejected tests.
2. **Classification order (item 3).** `conflict()` and `STALE_SUFFIX` are checked before
   `hook_hint`. Both are git-authored and line-anchored, while hook words occur in file and
   branch names. Hook-origin text (a husky banner, "hook … failed") still classifies as
   `HookRejected` because it carries no conflict marker.
3. **Symlink restore probe (item 4).** Compare `Oid::hash_object(Blob, target_bytes)`
   in-process for the `Symlink` arm, with no subprocess. `Regular` keeps `hash-object`, so
   clean/smudge filters still apply.
4. **Remote ref delete (item 5).** One `delete_remote_ref(repo, cred, remote, destination,
   expected_oid)` holds the missing-ref match and the `ls-remote` absence probe. On
   confirmed absence of a branch it also runs `update-ref -d refs/remotes/<r>/<b>
   <expected_oid>`. Tags have no tracking ref. The `.` guard (item 68) lives in the same
   function.
5. **PATH probe (item 9).** Print `__GL_PATH_START__${PATH}__GL_PATH_END__` and take only
   the text between the markers. Move `output_within` from `acp/process.rs` to `shell.rs` (the
   lower layer) and call it with a 5 s timeout. On timeout, fall back to `augment` over the
   inherited PATH. `acp/cursor.rs` imports it from `shell`.
6. **Worktree blame (item 10).** For `revision: None`, run `blame_file` on HEAD, then
   `blame.blame_buffer(worktree_bytes)`, and index the buffer blame. A zero-oid hunk renders
   as the existing "Uncommitted" row.
7. **Worktree text cap (item 18).** Keep the 8 MiB `MAX_WORKTREE_TEXT_BYTES`, add
   `tooLarge: bool` to `ConflictFileContent`, read staged conflicts with the same cap instead
   of `repo_file_text`'s 2 MiB, and add the §1a table row.
8. **Obstruction scan (item 15).** Build a `HashSet` of target keys and all their directory
   prefixes once per capture. An untracked key obstructs if it or any ancestor is a target
   file, or if it is a prefix in the set.

### Needs a decision (no task until decided)

- **Item 16, tip squash.** Should `squash_commits` refuse a span that is on a remote or
  contains a merge, like `squash_range`? Yes means calling `linear_span`.
- **Item 17, watcher `objects/`.** Classify `.git/objects/…` as `Ambiguous` (the ref
  fingerprint decides), accepting that the pinned tests change.
- **Item 19, `VAR=value` ACP prefix.** Support it (peel assignments into `cmd.env`) or
  reject it in both the probe and the launcher.
- **Item 61, commit-agent instruction fields.** Drop `descriptionInstruction` and
  `commitInstruction`. The on-disk format then needs `#[serde(default, skip_serializing)]` or a
  migration.
- **Item 62, unused wire fields.** Remove them, unless UI for submodule URLs, LFS patterns
  or sparse mode is planned.
- **Item 73, stash and reflog caps.** Pick the cap values and add `truncated` flags.
- **Item 78, size-script line count.** Count newlines like `wc -l`, and change the pinned
  test.

## Risks / Trade-offs

- [Item 3 reorder] → a real hook rejection whose output also contains a `CONFLICT` line is
  now reported as a conflict. git stops on the conflict before commit hooks run, so that
  output does not occur in one run.
- [Item 5 tracking-ref drop] → guarded by `<expected_oid>`, so a ref the user re-fetched
  in the meantime is left alone.
