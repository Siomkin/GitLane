## Why

GitLane can inspect and merge Cursor Origin pull requests, but it still hides creation and lifecycle actions that the installed Origin CLI now supports. The external PR affordance can also fail without feedback because the asynchronous system-browser opener result is discarded.

## What Changes

- Allow users to create Cursor Origin pull requests from the existing create-PR dialog, preserving the selected open/draft state.
- Allow users to close, reopen, and mark Cursor Origin pull requests ready through the existing lifecycle controls.
- Keep Origin merge restrictions unchanged: merge commit or squash only, with no delete-branch option.
- Surface external PR-opening failures instead of leaving a click with no visible result, while retaining URL validation and the shared system-browser opener.
- Update focused Rust argument-builder and frontend interaction tests, plus the Origin behavioral specification.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `forge/origin`: Extend the existing Origin pull-request surface with create and lifecycle actions, and require actionable feedback when an Origin PR cannot be opened externally.

## Impact

- Jira: none.
- Processes: Rust Origin-provider implementation and React/TypeScript frontend behavior. Existing IPC commands, serde/TypeScript types, store actions, and Tauri handler registrations are reused unchanged.
- Primary implementation seams: `src-tauri/src/git/forge/origin/ops.rs`, `src-tauri/src/git/forge/origin/mod.rs`, `src/lib/forgeHelp.ts`, `src/features/pull-requests/PrActions.tsx`, and `src/lib/openExternal.ts`.
- Dependencies: none. The existing `origin` CLI boundary and `@tauri-apps/plugin-opener` remain authoritative.
- Secrets/auth risk: no new credential path. All Origin commands continue using the user's Origin CLI session; tokens must not enter IPC, frontend state, logs, or returned errors.

## Non-goals

- Editing Origin PR titles, descriptions, or base branches.
- Adding reviews, new top-level discussion comments, or new inline review threads.
- Adding new IPC commands, stores, dependencies, or an Origin-specific browser-opening subsystem.
- Changing GitLab or Bitbucket lifecycle availability.
