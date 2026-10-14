# Proposal

## Why

Checking out a remote branch whose local counterpart is behind (the normal state right after a
fetch) runs the user's checkout hooks twice. GitLane first switches to the stale local tip, which
fires `post-checkout`, and then fast-forwards with `merge --ff-only`, which fires `post-merge`.
The first run also sees a tree that is about to change. On the GoldX repository a local
`post-checkout` hook (Docker compose, then waiting for `php artisan`) takes about 10 s per run, so
a single checkout took 20 s or more. During that time GitLane showed nothing: the store's `loading`
flag only disables a few toolbar buttons, and the hook's output (including its own failure
messages) was thrown away.

There is no Jira issue for this change.

## What Changes

- **Remote-branch checkout moves the ref first, then switches once.** When the local counterpart
  exists and is not checked out, GitLane classifies it against the remote-tracking ref as it does
  today (fast-forward, equivalent sibling, or diverged). It then moves the local ref to the remote
  tip with a compare-and-swap and runs a single `git switch` onto the final commit. Checkout hooks
  run once, against the final tree, and `post-merge` does not run.
- **The local branch that is already checked out is updated in place, without a switch.** Its
  fast-forward runs as today (`merge --ff-only`, which fires `post-merge` once). It no longer also
  runs a no-op `git switch` first, so `post-checkout` does not fire as well.
- **No half state on a dirty tree.** Today the switch can succeed while the fast-forward fails,
  leaving HEAD on the stale tip. With the new order, either the switch to the final tip succeeds
  or HEAD stays where it was. The local ref may already have been fast-forwarded, which is a safe
  move of a branch that is not checked out.
- **Checkout shows that it is busy.** A checkout that takes noticeably long shows a progress card
  ("Checking out develop…") until git returns. This covers every entry point: double-clicking a
  ref pill, the branch menus, the drag action menu, and the PR menu.
- **Hook output is shown.** GitLane runs `git switch` with `--quiet`, so any output left after a
  successful checkout comes from hooks or git warnings. When it is not empty, GitLane shows it in
  the success notification. A failed checkout keeps showing git's full error output, including
  hook output, as it does today.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `history/write-ops`: adds requirements for checking out a remote-tracking branch with a single
  switch (hooks run once, no half-updated state), and for checkout progress and hook-output
  feedback. No existing requirement changes, so these are all ADDED.

## Non-goals

- Changing or diagnosing the user's own hooks (GoldX's `php-switch` stays as it is). Running hooks
  in the background or with a timeout is the hook author's choice, not GitLane's.
- Streaming hook output live while checkout runs. The card shows that work is in progress; the
  output is shown once git returns.
- Showing progress for other hook-running writes (commit, merge, rebase, pull). Pull already has
  a progress card; the others can reuse the same helper later if needed.
- Changing worktree hand-off, detached checkout semantics, or the "branch is in another worktree"
  dialog.

## Impact

- **Rust**: `src-tauri/src/git/write/branch_checkout.rs` reorders `checkout_remote_branch`.
  `src-tauri/src/git/write/head.rs` adds `--quiet` to `switch_branch` / `switch_detached`; the
  worktree hand-off (`worktrees/handoff_move.rs`) uses those helpers and only checks success.
  The tests under `git/write/tests/branch_checkout/` change their dirty-tree expectation and gain
  hook-count tests.
- **Frontend**: `src/store/repoWriteActions/checkout.ts` wraps the three checkout actions in a
  delayed progress card and a success notification that carries the hook output. It follows the
  pull action in `repoWriteActions/remotes.ts`, which already uses `useNotifications` progress
  cards.
- **IPC**: no shape change. `checkout` and `checkout_remote_branch` already return a `String`;
  only what it contains changes (hook and warning output instead of git's switch chatter).
- **Secrets**: `run_git` redacts only failure output; success output is returned raw so parsers
  can read it. Checkout's success output now reaches the UI, so the checkout write MUST pass it
  through `redact::redact_secrets` before returning it. No credential parameter is added to IPC.
- **Dependencies**: none.
