# Proposal

## Why

The 2026-09-25 audit found about thirty places where one implementation disagrees with a
sibling that does the same job. Each disagreement is small, but most are visible to users:

- A remote whose name contains `/` gets a false "publish" prompt.
- The hand-off dialog counts a partly staged file twice.
- `pull` skips the conflict-aware runner and refreshes nothing on failure.
- A main-checkout tab rebuilds its graph on every sibling worktree's index write.
- `range_commits` truncates silently (rule §1a).
- Some whole-file reads have no size cap.
- `cursor --list-models` runs with no timeout.
- The same author gets three different avatar initials.
- The title-bar Search button does nothing.

No Jira issue exists yet.

## What Changes

- **Rust reads and subprocesses:**
  - The search seed shares the graph seed (`graph::seed_walk`).
  - The watcher treats `worktrees/<name>/index` like the commondir rule.
  - `range_commits` reports `truncated`.
  - Every worktree whole-file read goes through the bounded reader.
  - `cursor_cli_models` runs under the ACP watchdog.
  - `ordered_commits` uses one topological walk.
  - The worktree-removal lease probes the canonical workdir.
  - Index-lock recovery on Windows (decided: option (a), see design).
- **Frontend alignment:**
  - `branchSync.ts` uses `BranchInfo.remote`.
  - `pull` runs through `runMaybeConflict`.
  - Two request lanes claim before they publish.
  - "Follow the working tree" becomes one helper.
  - The hand-off count uses `summarizeChanges`.
  - `useRemoveWorktree` reuses `previewConfirm`'s freshness guard.
  - The hand-off "still running" gate matches its siblings.
  - `selectCommit(null)` and the PR-state reset on repo switch are fixed.
  - `agentsCache` clears `loading`.
  - Hunk-staging policy is decided in one place.
  - The file-filter Escape respects overlays.
  - The ref pill marks only branches as "current".
  - The 200-result cap is one constant.
- **One helper per concept:**
  - Author avatars go through `personVisual`, and one `initials`.
  - One `formatBytes` and one relative-time helper.
  - One path-trim helper.
  - The built-in AI-action ids are derived from the defaults.
  - `accountMatchesRemoteHost` and `glabUsableFor` are shared.
  - One `useCopyFeedback`, and ReviewNotes only closes when the copy succeeds.
  - `StatusBadge` is used in the AI-actions popover.
  - Diff colour tokens are shared.
  - WorktreeRow and TerminalTabs no longer nest buttons.
- **Title-bar Search:** wire it to the history search (decided: wire it).
- **Stash lane placement in `historyRows.ts` (A6-2):** decided: document the exception (see design).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

_None._ `skip_specs: true`. Each item makes a unit behave like its existing sibling or
like an already-specified rule, for example `ipc/commands` "List and blob responses are
bounded" and "Repository reads keep the interface responsive". None adds a new requirement.

## Non-goals

- The frontend import-direction backlog (changes↔agents, agents↔terminal).
- The forge capability model, typed IPC enums, and backend dedupe. Those are the sibling
  audit changes.
- Visual redesign. Colour and avatar unification keeps the existing tokens.

## Impact

- **Processes:** Rust (`git/read/search.rs`, `git/graph*`, `watcher/classification.rs`,
  `git/read/range.rs`, `git/worktree_fs`, `acp/`, `git/write/index_lock.rs`,
  `worktree_removal_lease.rs`, `git/types`), frontend (`src/lib/*`, `src/store/*`,
  `src/features/{graph,changes,review,conflicts,repo-files,history-inspect,terminal,agents}`,
  `src/components/{ui,navigation,chrome}`).
- **IPC:** `range_commits` returns `{ commits, truncated }`. All four layers change
  together. No other signature changes.
- **Secrets/auth:** none.
