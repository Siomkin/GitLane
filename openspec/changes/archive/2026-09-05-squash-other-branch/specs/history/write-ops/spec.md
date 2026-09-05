## ADDED Requirements

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
