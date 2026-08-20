## Why

GitLane's Cursor Origin provider now covers pull-request discovery, inspection, creation, lifecycle changes, merge, and existing review threads, but its Checks tab is always empty and its discussion composer is hidden even though the current Origin CLI supports checks, comments, and approvals. This leaves common review work unnecessarily dependent on the Codebase web UI.

## What Changes

- Load Origin CI checks into GitLane's existing Checks tab and normalize Origin status/conclusion values into GitLane's pass, fail, pending, and skipped states.
- Load submitted Origin review verdicts into the existing pull-request detail metadata.
- Enable new top-level discussion comments for Origin through the existing PR composer.
- Enable Origin approvals through the existing review flow while continuing to hide Request changes, which the current Origin CLI marks unsupported.
- Keep all commands pinned to the selected pull-request number and repository through the existing Origin provider and `run_origin` boundary.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `forge/origin`: Extend the existing Origin pull-request surface with CI checks, submitted review display, top-level comments, and approvals.

## Impact

- Jira: none.
- Processes: Rust Origin-provider reads/writes and React/TypeScript capability gating. Existing IPC commands, serde/TypeScript wire types, store actions, Checks tab, and composer are reused.
- Primary implementation seams: `src-tauri/src/git/forge/origin/{ops.rs,dto.rs,mod.rs}` and `src/features/pull-requests/PrConversation.tsx`, following the existing GitHub provider and PR composer patterns.
- Dependencies: none; the installed `origin` CLI remains authoritative.
- Secrets/auth/IPC risk: no new credential or IPC path. Origin authentication stays in the user's CLI session; tokens must not enter frontend state, logs, or returned errors.

## Non-goals

- Adding a PR-edit dialog, auto-merge controls, ready-to-draft conversion, close/reopen comments, historical change-version browsing, or manual `origin pr refresh`; GitLane has no shared product surface for these today.
- Adding Origin request-changes reviews (unsupported by the current Origin CLI), formal comment-only reviews (supported by the CLI but with no GitLane composer action — a top-level comment covers it), reviewer requests, or new inline review threads.
- Replacing the provider-neutral PR contract, adding provider capability infrastructure, or changing GitHub, GitLab, or Bitbucket behavior.
