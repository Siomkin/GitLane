# Spec Delta

## ADDED Requirements

### Requirement: Remote-branch checkout switches once, onto the final commit

When the user checks out a remote-tracking ref whose local counterpart exists and is not checked out, GitLane SHALL bring the local branch up to the remote tip before switching to it. The working tree SHALL change once, directly to the final commit, so the repository's `post-checkout` hook runs once and `post-merge` does not run. The rules that decide whether the update is allowed (fast-forward, equivalent sibling, diverged) are unchanged.

#### Scenario: Local counterpart is behind the remote
- **WHEN** the local `develop` is an ancestor of `origin/develop`, `develop` is not checked out, and the user checks out `origin/develop`
- **THEN** `develop` points at the `origin/develop` commit and is checked out
- **AND** `post-checkout` ran exactly once, with the `origin/develop` commit as its new HEAD
- **AND** `post-merge` did not run

#### Scenario: Local counterpart already matches or is ahead
- **WHEN** the local `develop` equals `origin/develop` or is ahead of it, and the user checks out `origin/develop`
- **THEN** `develop` is checked out at its own tip without moving
- **AND** `post-checkout` ran exactly once

#### Scenario: Equivalent sibling commit
- **WHEN** the local tip and the remote tip have the same parents and the same tree, and the user checks out the remote ref
- **THEN** the local branch points at the remote commit and is checked out with a single switch

#### Scenario: Diverged branch is refused before anything moves
- **WHEN** the local counterpart has diverged from the remote-tracking ref
- **THEN** the checkout is refused, and HEAD, the working tree, and the local branch are all unchanged

### Requirement: Updating the checked-out branch from its remote does not re-check it out

When the user checks out a remote-tracking ref whose local counterpart is already the current branch, GitLane SHALL update the branch in place and SHALL NOT switch to it again. A fast-forward fires `post-merge` once, and `post-checkout` does not run.

#### Scenario: Current branch is behind the remote
- **WHEN** `develop` is checked out and behind `origin/develop`, and the user checks out `origin/develop`
- **THEN** `develop` is fast-forwarded to `origin/develop`
- **AND** `post-merge` ran once and `post-checkout` did not run

#### Scenario: Current branch already matches the remote
- **WHEN** `develop` is checked out at the `origin/develop` commit, and the user checks out `origin/develop`
- **THEN** nothing changes and no checkout or merge hook runs

### Requirement: A refused switch leaves HEAD where it was

If the final switch of a remote-branch checkout is refused (for example, local changes would be overwritten), HEAD and the working tree MUST stay on the commit they were on before the action. GitLane MUST NOT leave HEAD on the local counterpart's previous, stale tip. The local counterpart, which was not checked out, MAY already have been moved to the remote tip.

#### Scenario: Dirty file conflicts with the remote tip
- **WHEN** the user is on `feature` with an uncommitted change to a file that differs between `feature` and `origin/develop`, the local `develop` is behind, and the user checks out `origin/develop`
- **THEN** the checkout fails with git's error naming the file
- **AND** HEAD is still `feature` and the uncommitted change is intact

### Requirement: Remote-branch checkout refuses a branch held by another worktree before moving it

When another worktree of the repository holds the local counterpart, a remote-branch checkout run against a different worktree MUST be refused before any ref, index, or working tree changes. A worktree holds a branch when its HEAD is on it (even if its directory is missing), or when a rebase or bisect paused there was started from it. A checkout routed to the worktree that holds the branch follows the current-branch rule.

#### Scenario: Branch is checked out elsewhere
- **WHEN** `develop` is checked out in a linked worktree, and a remote-branch checkout of `origin/develop` runs against the main worktree
- **THEN** it fails, and `develop`, the linked worktree, and the main worktree are all unchanged

#### Scenario: Holding worktree's directory is missing
- **WHEN** `develop` is checked out in a linked worktree whose directory has been deleted or is on an unmounted volume, and a remote-branch checkout of `origin/develop` runs against the main worktree
- **THEN** it fails and `develop` is unchanged

#### Scenario: Branch is being rebased or bisected elsewhere
- **WHEN** a linked worktree is paused in a rebase or bisect started from `develop`, so its HEAD is detached, and a remote-branch checkout of `origin/develop` runs against the main worktree
- **THEN** it fails, naming the rebase or bisect, and `develop` is unchanged

#### Scenario: Fast-forwarding a branch being rebased elsewhere
- **WHEN** the user fast-forwards `develop` directly while a linked worktree is paused in a rebase of it
- **THEN** the fast-forward is refused and `develop` is unchanged

### Requirement: A slow checkout shows a progress indicator

While a branch, remote-branch, or detached checkout is running, GitLane SHALL show a progress card that names the target, if the checkout has not finished within a short delay. The card SHALL disappear when git returns, whether it succeeded or failed. A checkout that finishes within the delay SHALL show no card.

#### Scenario: Checkout blocked by a slow hook
- **WHEN** the user double-clicks the `origin/develop` ref pill and the repository's `post-checkout` hook takes 10 seconds
- **THEN** a progress card reading "Checking out develop…" is visible while the hook runs
- **AND** the card is gone once the checkout returns

#### Scenario: Fast checkout
- **WHEN** a checkout completes within the delay
- **THEN** no progress card appears

### Requirement: Checkout output from hooks is shown to the user

After a successful checkout, GitLane SHALL show the output git produced besides its own switch messages, such as hook output or warnings, in a notification that names the checked-out target. Long output SHALL keep its first and last lines, with the middle marked as omitted. A successful checkout with no such output SHALL show no extra notification. A failed checkout SHALL keep showing git's full error output, including hook output, secret-redacted as all git output is.

#### Scenario: Hook prints output
- **WHEN** the `post-checkout` hook prints `[php-switch] containers up for PHP 8.4` and the checkout succeeds
- **THEN** a notification titled with the checked-out branch shows that line

#### Scenario: No hook output
- **WHEN** the repository has no checkout hooks and the checkout succeeds
- **THEN** the graph updates and no output notification is shown

#### Scenario: Very long hook output
- **WHEN** a `post-checkout` hook prints hundreds of lines and the checkout succeeds
- **THEN** the notification shows the first and last lines of the output, with a line saying how many lines in between were omitted

#### Scenario: Leaving a detached HEAD with unreachable commits
- **WHEN** HEAD is detached on a commit no branch reaches, and the user checks out a branch
- **THEN** the notification shows git's warning that commits are being left behind

#### Scenario: Hook output secret redaction
- **WHEN** hook output contains a token-shaped secret
- **THEN** the notification shows it redacted, exactly as an error toast would
