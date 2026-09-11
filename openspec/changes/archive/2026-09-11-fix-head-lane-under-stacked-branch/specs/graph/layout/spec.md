## Purpose

Defines which swimlane column a commit renders in when more than one column is waiting for it, so that merge connectors always reach their real target without visually crossing unrelated commits.

## ADDED Requirements

### Requirement: A merge connector never crosses commits that are not its target

When a commit is awaited by both a branch-root column (a merge introduced it as a topic branch) and a first-parent continuation column (a child branch continues into it), GitLane MUST render the commit in the branch-root column. This rule MUST apply to the checked-out commit exactly as it applies to any other commit. Consequently, the connector from a merge to its second parent MUST NOT pass through any commit that lies between the merge row and the target row in the target's column. The working-tree row MUST continue in the column where the checked-out commit renders.

#### Scenario: Checked-out branch merged into trunk while another branch is stacked on it
- **WHEN** HEAD is `feature`, trunk has a merge commit whose second parent is `feature`'s tip, and a further branch `stacked` has commits whose first-parent chain ends at `feature`'s tip, and `stacked`'s commits render between the merge and `feature`'s tip
- **THEN** `feature`'s tip renders in the column the merge connector descends, no `stacked` commit occupies that column between the merge row and `feature`'s row, the merge renders right of `feature`'s tip, and the working-tree row shares `feature`'s column

#### Scenario: Checked-out branch with no merge pointing at it keeps its mainline column
- **WHEN** HEAD is `feature` and no visible merge has `feature`'s tip as a second parent
- **THEN** `feature`'s tip renders in the leftmost column and the working-tree row shares it (unchanged behaviour)

#### Scenario: Commit that is not HEAD and is both merged and stacked on
- **WHEN** a non-checked-out commit is the second parent of a merge and also the first parent of a later branch's commits
- **THEN** it renders in the merge's branch-root column and the later branch's connector curves into it (unchanged behaviour, stated as the shared rule)
