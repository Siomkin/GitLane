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
- **WHEN** PIS-1802 is checked out with staged, unstaged, and untracked work and the user squashes two adjacent tip commits on PIS-1803
- **THEN** PIS-1803 contains one replacement commit for the selection and PIS-1802 and all uncommitted work remain unchanged

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
