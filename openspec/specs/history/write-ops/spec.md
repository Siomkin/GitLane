## Purpose

Lets a user rebase a remote-tracking feature onto a local base without moving that base, then publish the rewritten local branch to its upstream with a leased force-push when the histories have diverged.

## Requirements

### Requirement: Rebase of a remote-tracking feature onto a different local base moves the feature

When the user rebases a remote-tracking ref onto a local branch that is not that ref’s local counterpart, GitLane MUST replay the feature’s local counterpart onto the local base. GitLane MUST NOT move the local base onto the remote-tracking ref. If the local counterpart does not exist, GitLane MUST create and check it out from that remote-tracking ref (same as an explicit remote checkout) before the rebase. The confirmation MUST name the local counterpart as the branch that moves and the local base as the onto target, including a checkout prerequisite when HEAD is not already that counterpart. Cancelling the confirmation MUST leave every ref unchanged.

A remote-tracking ref’s local counterpart is the local branch with the same branch name under that remote (the branch an explicit “checkout this remote ref” would create). Dropping or targeting a remote-tracking ref onto its own counterpart is not this requirement.

#### Scenario: Drop a remote feature onto develop rebases the feature
- **WHEN** the user drops remote-tracking `origin/feature` onto local `develop` and confirms rebase
- **THEN** local `feature` exists (created from `origin/feature` if it was missing), `feature` has been replayed onto `develop`, and `develop` still points at the same commit as before the rebase

#### Scenario: Confirmation names the moving feature, not the base
- **WHEN** the user chooses rebase after dropping `origin/feature` onto `develop` while HEAD is `develop`
- **THEN** the confirmation states that `feature` will be checked out and rebased onto `develop`, and it does not state that `develop` will be rebased onto `origin/feature`

#### Scenario: Inverse rebase is not the only rebase offered
- **WHEN** the user drops `origin/feature` onto local `develop`
- **THEN** the rebase action offered is replaying `feature` onto `develop`, and there is no rebase action whose only effect would be moving `develop` onto `origin/feature`

#### Scenario: Cancelled rebase leaves the base and the remote untouched
- **WHEN** the user drops `origin/feature` onto `develop` and cancels the rebase confirmation
- **THEN** `develop`, `origin/feature`, and any existing local `feature` still point at the same commits as before

#### Scenario: Existing local counterpart is the rebase source
- **WHEN** local `feature` already exists and the user confirms rebase of `origin/feature` onto `develop`
- **THEN** GitLane rebases that local `feature` onto `develop` and does not create a second local branch

### Requirement: Updating a local branch from its own remote counterpart still moves the local branch

When the user rebases a remote-tracking ref onto the local branch that is its counterpart (or rebases that local branch onto its upstream remote-tracking ref), GitLane MUST move the local branch onto the remote-tracking commit. That local branch MUST be the one that moves.

#### Scenario: Drop origin/feature onto local feature updates the local branch
- **WHEN** the user drops `origin/feature` onto local `feature` and confirms rebase
- **THEN** local `feature` is replayed onto `origin/feature` and no other local branch is moved

#### Scenario: Drop a local branch onto a remote-tracking ref still moves the local branch
- **WHEN** the user drops local `feature` onto `origin/develop` and confirms rebase
- **THEN** `feature` is replayed onto `origin/develop` and the remote-tracking ref is unchanged

### Requirement: Local-to-local rebase keeps the dragged branch as the actor

When both the drag source and the drop target are local branches, GitLane MUST rebase the dragged branch onto the drop target. The drop target MUST NOT be rebased onto the dragged branch by that action.

#### Scenario: Drag feature onto develop rebases feature
- **WHEN** the user drops local `feature` onto local `develop` and confirms rebase
- **THEN** `feature` is replayed onto `develop` and `develop` still points at the same commit as before the rebase

### Requirement: A diverged rewritten branch can be published with force-with-lease from the push chrome

When the current local branch has an upstream and its sync status is diverged, GitLane MUST offer a force-push that uses `--force-with-lease` (preview, then confirm, then push) from the same chrome where Push normally lives. Regular Push MUST stay disabled for that diverged state. GitLane MUST NOT run a leased force-push unless the user confirms. If the remote branch moved after the preview, the force-push MUST abort without overwriting that remote. After a successful leased force-push, the local branch and its upstream MUST no longer appear as two divergent tips for that rewrite.

The existing branch-menu force-push MAY remain. This requirement is that the user does not have to find a danger-zone item in order to publish a rebase.

#### Scenario: Action bar offers force-push when the current branch is diverged
- **WHEN** the current branch tracks an upstream and is diverged from it (ahead and behind)
- **THEN** regular Push is disabled and a Force push control is enabled in the same push chrome

#### Scenario: Confirmed force-push updates the remote feature after a rebase
- **WHEN** the user has rebased local `feature` onto `develop` so it is diverged from `origin/feature`, and they confirm Force push
- **THEN** GitLane force-pushes `feature` with `--force-with-lease` and the graph no longer shows a stale `origin/feature` at the pre-rebase commit

#### Scenario: Force-push is not automatic after rebase
- **WHEN** a rebase of a published branch completes and the branch is now diverged from its upstream
- **THEN** GitLane does not push until the user confirms Force push

#### Scenario: Lease aborts when the remote moved
- **WHEN** the user confirms Force push and the upstream commit no longer matches the lease captured at preview
- **THEN** the remote branch is not overwritten and the user is told the lease failed

### Requirement: Squash selected commits on another local branch
GitLane SHALL allow squashing at least two contiguous, unpublished, single-parent commits on another local branch without checking it out. The replacement SHALL preserve the selected range's final tree and parent; descendants above the range SHALL retain their trees and order. Only the chosen branch SHALL move. HEAD, the current branch tip, index, working files, and current ORIG_HEAD SHALL remain unchanged.

#### Scenario: Two commits on a sibling branch
- **WHEN** main is checked out with staged, unstaged, and untracked work and the user squashes two adjacent tip commits on feature
- **THEN** feature contains one replacement commit for the selection and main and all uncommitted work remain unchanged

#### Scenario: Range below the other branch tip
- **WHEN** an eligible selected range ends below the target tip
- **THEN** descendants are replayed in order and the target's final tree is unchanged

#### Scenario: Several eligible branches
- **WHEN** the selection is not eligible on the current branch but is eligible on multiple local branches
- **THEN** the menu offers explicitly named branch actions and the prompt names the branch that will move

#### Scenario: Cancel the prompt
- **WHEN** the user cancels the squash message prompt
- **THEN** no repository mutation occurs

### Requirement: Other-branch squash validates its target before mutation
The operation MUST reject stale, deleted, symbolic, or checked-out targets, published rewritten spans, merges, roots, or noncontiguous ranges. It MUST preserve existing current-branch squash behavior and record successful target moves in that branch's reflog. The prompt MUST disclose that commit hooks do not run for this rewrite.

#### Scenario: Target changes while entering the message
- **WHEN** the target branch moves or is deleted after the prompt opens
- **THEN** squash fails with a refresh instruction without moving any branch

#### Scenario: Target checked out in a linked worktree
- **WHEN** the selected target is checked out in another worktree
- **THEN** squash refuses to rewrite it and leaves both worktrees unchanged

#### Scenario: Unsafe range
- **WHEN** the rewritten span includes published commits or a merge, or the selection is noncontiguous or includes a root
- **THEN** squash is unavailable or rejected without moving refs

### Requirement: A committed message is the message the user wrote

The commit message GitLane composes from the user's summary and description MUST be recorded as
written. The user's message-cleanup configuration MUST NOT drop, reorder, or promote any line of it.

#### Scenario: The summary begins with a comment character

- **WHEN** the user's configuration strips comment lines from commit messages and the user commits a
  summary beginning with `#` together with a description
- **THEN** the resulting commit's subject is the summary the user typed
- **AND** the description follows it unchanged

#### Scenario: A description line begins with a comment character

- **WHEN** a description contains a line beginning with the configured comment character
- **THEN** that line is present in the committed message

### Requirement: HEAD is identified unambiguously

GitLane MUST determine the checked-out branch by its full reference name. A tag, remote-tracking ref,
or other reference sharing the branch's name MUST NOT change the identification, and MUST NOT cause
an operation guarded by the current branch to be refused.

#### Scenario: A tag shares the checked-out branch's name

- **WHEN** the checked-out branch is `latest` and a tag named `latest` also exists
- **THEN** committing, stashing, squashing, pulling, and resetting all proceed
- **AND** none of them reports that HEAD changed

#### Scenario: HEAD is detached

- **WHEN** HEAD is detached
- **THEN** GitLane reports no current branch rather than an ambiguous name

### Requirement: A merged branch can be deleted after its remote counterpart is gone

Deleting a branch without forcing MUST succeed whenever git itself would allow it. When a branch has
a configured upstream that no longer exists, the merged check MUST fall back to HEAD, which is what
git does.

#### Scenario: The upstream branch was deleted after the pull request merged

- **WHEN** a branch was pushed with an upstream, merged, its remote counterpart deleted, and the
  remote pruned, and the user deletes the branch without forcing
- **THEN** the branch is deleted
- **AND** GitLane does not claim the branch is unmerged with respect to a reference that no longer
  exists

#### Scenario: The branch is genuinely unmerged

- **WHEN** a branch holds commits that are on no other reference and the user deletes it without
  forcing
- **THEN** GitLane refuses and offers a force delete

### Requirement: A new branch does not inherit an upstream it was merely started from

When a branch is created from a remote-tracking ref whose name differs from the new branch's, the new
branch MUST NOT be configured to track that ref. This MUST hold however the start point is spelled
and whichever operation creates the branch, because the configured upstream is what a later push
uses as its destination.

#### Scenario: A feature branch is created from a differently-named remote base

- **WHEN** the user creates a branch `feat` starting from the remote base `develop`, whether by
  spelling the start point in full or in its short form
- **THEN** `feat` has no configured upstream
- **AND** pushing `feat` publishes it under its own name rather than updating the base

#### Scenario: A feature branch is created together with a new worktree

- **WHEN** the user creates a worktree and a new branch in one action, starting from a
  differently-named remote base
- **THEN** the new branch has no configured upstream
- **AND** pushing from that worktree publishes the new branch rather than updating the base

#### Scenario: A branch is created from its own same-named remote counterpart

- **WHEN** the user creates a branch `topic` starting from the remote `topic`
- **THEN** the branch tracks that remote counterpart, as git does by default

### Requirement: A batch cherry-pick or revert never silently drops commits

When the user applies several commits in one action, GitLane MUST either apply all of them or report
exactly which ones were not applied. A conflict part-way through MUST NOT leave the remainder
unapplied and unreported.

#### Scenario: A selection mixes merge and non-merge commits

- **WHEN** the user selects a mixture of merge and non-merge commits to cherry-pick or revert
- **THEN** GitLane refuses the batch and explains that merges must be applied on their own

#### Scenario: A conflict stops a multi-commit batch

- **WHEN** a batch of non-merge commits conflicts part-way through and the user resolves and continues
- **THEN** the remaining commits are applied, or GitLane names the commits it did not apply
- **AND** GitLane never reports the batch as fully applied when it was not

### Requirement: The reset preview describes only a reset that can run

The reset confirmation SHALL be built from the same mode parsing as the reset write. An unknown mode MUST be refused at preview time. It MUST NOT be previewed as a different mode.

#### Scenario: Unknown reset mode
- **WHEN** a reset preview is requested with mode `"keep"`
- **THEN** the preview fails with a validation error and no "Reset mixed" confirmation is shown

### Requirement: Conflicts and stale leases are never labelled as hook rejections

A write that stops on a merge conflict or a stale lease SHALL be reported as that, even when
a file or branch name in git's output contains a hook name such as `pre-commit` or `husky`.

#### Scenario: Conflict in a pre-commit config file
- **WHEN** a merge stops with `CONFLICT (content): Merge conflict in .pre-commit-config.yaml`
- **THEN** the conflict workspace opens and no "blocked by a Git hook" message is shown

#### Scenario: Stale lease on a hook-named branch
- **WHEN** the leased branch is `feature/pre-push-hook` and it moved since the preview
- **THEN** the error is a stale lease, and the refresh prompt is offered

### Requirement: Deleting a remote branch that is already gone succeeds

Deleting a branch on a remote SHALL succeed when the remote no longer has that branch, and
SHALL remove the stale remote-tracking ref, matching remote tag deletion.

#### Scenario: Forge auto-deleted the head branch after a merge
- **WHEN** the user deletes `origin/feature` from the graph and the server no longer has `feature`
- **THEN** the delete reports that the branch was not on the remote, and `origin/feature` disappears from the graph without a fetch

### Requirement: One remote's credential failure does not stop the others from fetching

A fetch of several remotes SHALL fetch every remote whose credential resolves, and report
the remote whose credential failed as that remote's failure.

#### Scenario: Bound account signed out on one remote
- **WHEN** `origin` is bound to a signed-out gh account and `upstream` is unbound
- **THEN** `upstream` is fetched, and the result names `origin` as failed with an authentication reason

### Requirement: Restoring a symlink compares the link itself

Deciding whether a worktree path differs from a commit SHALL compare a symlink's link
text, and SHALL never follow the link.

#### Scenario: Unchanged symlink
- **WHEN** the user restores a symlink that matches the commit
- **THEN** no "discard local changes" confirmation is shown

#### Scenario: Link to a device file
- **WHEN** a worktree symlink points at `/dev/zero`
- **THEN** the check finishes immediately without reading the target

### Requirement: The local repository is never a remote for branch deletion

A remote branch deletion SHALL refuse git's `.` pseudo-remote, so it can never delete a
local branch around the local branch-deletion guards.

#### Scenario: Malformed request
- **WHEN** a remote branch deletion names remote `.`
- **THEN** it fails and the local branch still exists

### Requirement: Write-error recovery acts on the repository that failed

A failed write's error toast SHALL bind its retry and index-lock recovery to the repository where the write ran. If that repository is no longer the open one, recovery MUST NOT inspect, remove locks in, or re-run the write against a different repository.

#### Scenario: Repo switch while a stage is in flight
- **WHEN** a stage in repo A fails with `indexLock` after the user has switched to repo B
- **THEN** "Remove lock & retry" never touches B's `.git/index.lock`, and it does not stage anything in B

### Requirement: The conflict list names the deleting side in terms of the running operation

For a modify/delete conflict, the conflict file list SHALL use the same operation-aware side names as the conflict editor. During a rebase or carry, where git's ours/theirs are reversed from the user's point of view, the list MUST NOT say the user deleted a file that upstream deleted.

#### Scenario: Upstream deleted a file during a rebase
- **WHEN** a rebase stops on a modify/delete conflict where the commit being rebased onto deleted the file
- **THEN** the list row and the editor both attribute the deletion to the rebased-onto side

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
