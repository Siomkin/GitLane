## Why

GitLane's Cursor Origin provider now covers pull-request discovery, inspection, creation, lifecycle changes, merge, and existing review threads, but its Checks tab is always empty and submitted reviews are not shown even though the current Origin CLI supports checks and approvals.

## What Changes

- Load Origin CI checks into GitLane's existing Checks tab and normalize Origin status/conclusion values into GitLane's pass, fail, pending, and skipped states.
- Load submitted Origin review verdicts into the existing pull-request detail metadata.
- Enable bodyless Origin approvals through the existing review flow.
- Keep all commands pinned to the selected pull-request number and repository through the existing Origin provider and `run_origin` boundary.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `forge/origin`: Extend the existing Origin pull-request surface with CI checks, submitted review display, and bodyless approvals.

## Impact

- Jira: none.
- Processes: Rust Origin-provider reads/writes and React/TypeScript capability gating. Existing IPC commands, serde/TypeScript wire types, store actions, and Checks tab are reused.
- Primary implementation seams: `src-tauri/src/git/forge/origin/{ops.rs,dto.rs,mod.rs}` and `src/features/pull-requests/PrConversation.tsx`.
- Dependencies: none; the installed `origin` CLI remains authoritative.
- Secrets/auth/IPC risk: no new credential or IPC path. Origin authentication stays in the user's CLI session; tokens must not enter frontend state, logs, or returned errors.

## Non-goals

- Adding a PR-edit dialog, auto-merge controls, ready-to-draft conversion, close/reopen comments, historical change-version browsing, or manual `origin pr refresh`; GitLane has no shared product surface for these today.
- Adding Origin comments, review bodies, request-changes reviews, formal comment-only reviews, reviewer requests, or new inline review threads.
- Replacing the provider-neutral PR contract, adding provider capability infrastructure, or changing GitHub, GitLab, or Bitbucket behavior.
