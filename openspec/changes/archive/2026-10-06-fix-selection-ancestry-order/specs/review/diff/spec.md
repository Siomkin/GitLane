# Spec Delta

## ADDED Requirements

### Requirement: Multi-commit merged diff follows ancestry order

When the user selects several commits, GitLane MUST compose the merged diff in ancestry order, oldest first, regardless of selection order, count, or committer timestamps. A file MUST be reported as changed by unselected in-between commits only when an unselected commit actually edited it between two selected commits.

#### Scenario: Contiguous run of several commits touching one file
- **GIVEN** a linear branch where five consecutive commits each edit the same file and no other commit touches it in that span
- **WHEN** the user selects all five commits
- **THEN** the file's merged diff is shown, equal to the diff from the file before the oldest selected commit to the file at the newest one
- **AND** no "changed in commits between the ones you selected" message appears

#### Scenario: Selection order does not matter
- **WHEN** the same contiguous commits are selected newest-first, oldest-first, or in any other order
- **THEN** the merged file list and every per-file diff are identical

#### Scenario: Identical commit timestamps
- **GIVEN** consecutive selected commits that share the same committer timestamp (for example, created in one rebase)
- **WHEN** the user selects them
- **THEN** the merged diff still follows parent-before-child order

#### Scenario: Genuine gap is still detected
- **GIVEN** selected commits A and C both edit a file and an unselected commit B between them also edits it
- **WHEN** the user selects A and C
- **THEN** the merged diff excludes B's edit, or explains that it cannot be shown when the selected edits cannot be separated from B's
