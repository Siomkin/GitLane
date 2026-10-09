# Proposal

## Why

The 2026-09-25 code-smell audit (`latest` @ c6e3d4e2) found fourteen places where
GitLane does the wrong thing today. Each one was checked against the current tree. They are
small, independent fixes, but together they hit Linux users, PR review, rebases, terminals,
and error recovery. Several of them already have a correct sibling a few files away that
the broken copy never picked up. No Jira issue exists yet.

## What Changes

- **Linux Reveal / Open-with-default-app work.** Stop passing `--` to `xdg-open`. Every
  released xdg-utils (1.1.3–1.2.1) rejects it as an unknown option (support was only added
  on master on 2025-10-25). Keep one OS reveal table in `shell.rs`.
- **The create-PR reviewer picker lists collaborators.** Use `repos/{owner}/{name}` and not
  the `host/owner/name` selector, which returns 404 on every GitHub and GHES repo.
- **The compare view pairs renames.** A renamed file in a branch/ref comparison shows its
  real change, not an all-added diff (apply the fix `file_diff` already has).
- **Terminals.** Every path that drops a repo tab disposes that tab's shells. Today only
  `closeRepo` does. `pty_write` no longer blocks the UI thread while holding the global
  terminal lock.
- **Write-error recovery targets the repo that failed.** "Retry" and "Remove lock & retry"
  bind to the owning repo, not whichever repo is open when the toast appears.
- **Escape closes the topmost layer.** A dialog opened from the branch navigator closes on
  Escape. Today the navigator underneath closes instead.
- **PR review display.** The thread "Author" badge compares logins, not display names.
  Markdown ordered lists keep their numbering.
- **Conflict list wording.** During a rebase or carry, the list's "deleted by you/them"
  follows the same operation-aware side labels the editor pane already uses.
- **Smaller correctness fixes.** An `acp-agents.json` that exists but can't be read is
  never overwritten. `HistorySearchResult` is built in one place (committer time, one
  short-id length), and the timestamp doc comments say "committer". `bun run bench:graph`
  targets the moved fixture and fails loudly when it matches zero tests.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `forge/github`: the create-PR dialog lists the repository's collaborators as reviewer candidates.
- `review/diff`: the compare view pairs a renamed file with its source.
- `terminal/session`: a tab's shells end when the tab leaves the strip, and typing never blocks the UI.
- `chrome/overlays`: Escape closes the topmost open layer.
- `pull-requests/detail`: the author badge matches by login, and ordered lists keep their numbering.
- `history/write-ops`: error recovery acts on the repo that failed, and conflict deletion labels follow the operation.

## Non-goals

- Anything the other audit changes own: the forge capability model
  (`declare-forge-capabilities-once`), typed IPC enums and error kinds
  (`type-the-ipc-and-write-boundary`), and duplicate/dead-code cleanup.
- Redesigning terminal session ownership. This change only routes every tab drop through
  one helper.
- New UI. Each fix restores behaviour that was already specified or already shipped in a
  sibling.

## Impact

- **Processes:** Rust (`shell.rs`, `git/write/reveal.rs`, `git/write/open_path.rs`,
  `git/forge/prs/mutations.rs`, `git/status/compare.rs`, `terminal.rs`,
  `commands/terminal.rs`, `acp_agents.rs`, `git/read/search.rs`, `git/read/range.rs`),
  frontend (`src/store/repoTab`, `repoLifecycle`, `repoMissing.ts`,
  `repoWriteActions/*`, `action-bar/useActionBarModel.ts`, `components/ui/Markdown.tsx`,
  `features/pull-requests/ReviewThreads.tsx`, `features/conflicts/ConflictFileRow.tsx`),
  scripts (`scripts/run-graph-benchmark.ts`).
- **IPC:** `pty_write` stays sync (in `SYNC_BY_DESIGN`, now as an enqueue to a per-session
  writer thread). Its name and arguments stay the same, so the TS wrapper does not change.
  No command signature changes.
- **Secrets/auth:** the index-lock retry now targets the right repo, so GitLane can no
  longer delete another repo's `.git/index.lock`. No token handling changes.
