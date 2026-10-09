# Proposal

## Why

The 2026-09-28 round-2 audit (`AUDIT.md`) found correctness and consistency problems in the
Rust core outside the forge providers: the write layer, the read side (status, blame,
graph), the watcher, the ACP and terminal agents, the login-shell PATH probe and the repo
scripts. This change groups them. It started as "the write layer" and also takes the rest of
the non-forge Rust core, so each backend finding has exactly one home. The worst are:

- The ACP `execute` allowlist can be bypassed by an argv array that re-splits into a
  different command, which could let an agent overwrite a user file (item 8, security).
- A merge conflict in a repo that uses pre-commit or husky is reported as "blocked by a Git
  hook" (item 3).
- Restoring an unchanged symlink always asks for confirmation, and can hang (item 4).
- Deleting a remote branch the server already dropped fails with `(stale info)` (item 5).
- A shell rc file that prints anything corrupts PATH, so `gh`/`glab` go missing, and a
  hanging rc file blocks every subprocess (item 9).
- Working-tree blame shows the wrong author for every line after an edit (item 10).

No Jira issue exists yet.

## What Changes

- ACP: validate the argv that will run; never join and re-split (8). The availability
  probe and the launcher agree on how a command is tokenised, once item 19 is decided.
- Error classification: git-authored conflict and stale-lease markers win over hook words (3).
- Write ops: symlinks hashed as links (4), idempotent remote branch delete that also drops
  the tracking ref (5), per-remote fetch credential failures (14), `.` refused as a remote
  (68), an O((U+T)·depth) obstruction scan (15), the discard re-capture wording aligned with
  hard reset (55), porcelain-z for the reset preview (56), and longest-remote matching (54).
- Read side: buffer blame for the working tree (10), one worktree-text cap with a
  `tooLarge` flag and a §1a row (18), bounded reads after the size check (71), unborn
  branch names in recents (57), and the main checkout's detached HEAD seeded in linked tabs (70).
- Process lifecycle: a sentinel-delimited, time-bounded PATH probe (9), exited shells
  reaped (69), and `acp_probe` inside the boundary (75).
- Types: `ConflictSide` enum (64), `unmergedCommits` on `DeleteBranchPreview` (65), and the
  signing-key home dir (21).
- Scripts and tests: a guarded fixture generator (76) and updater tests that read the real
  configs (77).
- Comments: the backend part of item 82 (write layer and read side).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `terminal/session`: an array-form execute command is validated as the argv that runs.
- `platform/git-invocation`: the login-shell PATH is taken only from the probe's own
  output, within a timeout.
- `history/write-ops`: conflict and stale-lease errors are never labelled as hook
  rejections, remote branch delete is idempotent, fetch continues past one remote's
  credential failure, a symlink restore compares the link itself, and `.` is not a remote.
- `review/diff`: working-tree blame attributes each line correctly.
- `graph/layout`: a linked-worktree tab seeds the main checkout's detached HEAD.

## Non-goals

- Forge providers and provider auth (`harden-forge-providers`), and frontend-only items
  (`harden-frontend-views`).
- The decisions in design.md (items 16, 17, 19, 61, 62, 73, 78) get no task until decided.

## Impact

- **Processes:** Rust (`git/write/**`, `git/status/**`, `git/graph/**`, `git/read/**`,
  `git/conflicts/**`, `git/worktree_fs/**`, `watcher/**`, `acp/**`, `terminal.rs`,
  `shell.rs`, `signing_keys.rs`, `commands/**`, `updater.rs`), `scripts/`, plus the
  frontend halves of the IPC items below.
- **IPC (all four layers in this change):** item 18 adds `tooLarge` to
  `ConflictFileContent`, rendered by `src/features/conflicts/ConflictEditor.tsx`. Item 64
  adds `ConflictSide`. Item 65 adds `DeleteBranchPreview.unmergedCommits`, read by
  `DeleteWorktreeDialog.tsx`. If decided, item 61 removes two fields from the commit-agent
  messages and item 62 removes unused wire fields.
- **Security:** item 8 changes the one execute-approval gate. Its rejected-case tests must
  grow and nothing that is rejected today may start passing.
