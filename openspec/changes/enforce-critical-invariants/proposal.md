# Proposal

## Why

A 2026-11-08 audit found nine properties that GitLane depends on with nothing enforcing them, and each failure loses work, produces a wrong git result, or exposes a secret. One was reproduced at the git level: removing a "stale" `index.lock` during a pre-commit hook created a commit with an empty tree.

There is no Jira issue yet. Process: Rust, frontend, and IPC.

## What Changes

- **UI-1:** every user action that would drop a dirty editor draft asks first, including switching tabs by click or shortcut, switching worktrees, selecting elsewhere, closing the window, using Quit from the menu or ⌘Q, and restarting for an update. Automatic reselection no longer closes an open editor.
- **LIFE-1:** `index.lock` removal is refused while any non-daemon `git` process is running.
- **GIT-2:** aborting a carry saves tracked work, including newly staged files, to a recovery stash before resetting. If HEAD has moved since the carry, abort ends the carry without touching any file.
- **GIT-1:** branch deletion and other-branch squash refuse a branch being rebased or bisected, using the existing branch-claim check.
- **GIT-3:** pull fast-forwards to the commit recorded for the requested ref when its fetch completed, by OID.
- **GIT-4:** merge integrates the validated OID, with the same generated message as today for branch, remote-tracking, and raw-commit sources.
- **FORGE-1:** PR writes carry the URL of the PR the user selected, and the backend refuses unless the same number in the target repository resolves to that URL.
- **FORGE-3:** redaction covers bare provider tokens, `Authorization` values, and token query parameters, without requiring a URL in the text.
- **FORGE-2:** the provider token stays out of hook environments and argv, now tested. Docs and comments stop implying that hooks cannot use git's credential route: hooks run as trusted user code.

## Capabilities

### New Capabilities

- `repo-files/editor`: protection of unsaved edits in the repository file editor.

### Modified Capabilities

- `history/write-ops`: index-lock removal, branch claims on delete and squash, exact-commit pull and merge.
- `conflicts/resolution`: aborting a carry.
- `pull-requests/detail`: PR writes reach the repository the user was viewing.
- `ipc/commands`: redaction of credentials in error text.
- `accounts/transport`: the provider-token boundary for hooks.

## Non-goals

- Lower-severity findings from the same audit.
- Single-use broker nonces. They would likely break Git LFS and multi-prompt fetches in provider-token mode; the user chose to narrow the promise instead.
- Blocking app exit during in-flight git writes (LIFE-4), or draft persistence or recovery after a crash.
- Protecting a draft from a native macOS terminate (Dock Quit, log-out, `osascript`), which the windowing layer cannot intercept.
- Protecting a draft when its repository disappears from disk or its host disconnects; that exit is not user-initiated.
- Hiding Delete in the branch menu for claimed branches. The backend refusal is the guard.

## Impact

**Secrets, auth, and IPC risk.** No new command takes a credential. PR URLs are non-secret and pass as ordinary arguments. FORGE-2 knowingly leaves a repository-controlled hook able to request the token through git's credential route, the same exposure as the user's own credential helper. Broader redaction can over-match token-shaped text in error messages; that is the safe direction.

**IPC.** Five PR write commands gain a required `pr_url` argument and `link_pull_request_stack` gains `pr_urls`, across the command signature and TS wrapper layers. All six are `LOCAL_ONLY` and stay so. Each PR write costs one extra provider read.

**Tauri.** Intercepting window close requires the `core:window:allow-destroy` capability, recorded in `docs/tauri-plugin-decisions.md`. No new plugin or package.

**Modules to copy.** `write/worktrees/claims.rs::branch_claim` (branch claims), `requestOpenRepoFile` in `src/store/repoFilesActions.ts` (dirty confirm), `git/write/head.rs::ensure_revision_at` (leases), `forge_op` in `commands/github.rs` (provider context).
