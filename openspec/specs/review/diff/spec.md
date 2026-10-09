## Purpose

Lets someone inspecting a merge commit see the files that came from either parent, so merging mainline into a feature does not look like a hundred-file change set.

## Requirements

### Requirement: Merge commit inspector can diff against any parent

When the user selects a merge commit that is not a stash, GitLane MUST show every parent in the inspector and MUST let the user choose which parent the changed-file list and per-file diffs are against. The default MUST be the first parent (same list as today’s first-parent `git show`). Choosing another parent MUST replace that list with the two-tree diff of that parent to the merge commit. Cancelling or switching back to the first parent MUST restore the first-parent list. A single-parent commit MUST keep showing only that parent and MUST NOT show a parent picker.

#### Scenario: First parent remains the default on a merge into develop
- **WHEN** the user selects a merge commit whose first parent is `develop` and whose second parent is a feature tip
- **THEN** the changed-file list is the diff against `develop` (the feature’s files), matching the first-parent view

#### Scenario: Merging develop into a feature exposes the other parent
- **WHEN** the user selects a merge commit whose first parent is the feature tip and whose second parent is the mainline branch (for example a `Merge branch 'develop' into my-feature` commit)
- **THEN** the default file list is the first-parent diff (mainline files brought into the feature) and the inspector also offers the second parent
- **AND** choosing the second parent shows the feature-scoped file list (the same paths as `git diff develop...HEAD` / vs that second parent)

#### Scenario: Parent control names the sides
- **WHEN** the user inspects a two-parent merge and a known ref points at a parent
- **THEN** that parent’s control includes the short sha and the ref name (for example `develop`), not only an unlabeled “parent”

#### Scenario: Ordinary commits are unchanged
- **WHEN** the user selects a commit with one parent
- **THEN** the file list remains the diff against that parent and no parent switcher appears

#### Scenario: Stash commits skip the merge-parent picker
- **WHEN** the user selects a stash commit
- **THEN** the file list remains the stash snapshot (tracked, index-only, and untracked) and the merge-parent picker is not shown

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

### Requirement: Working-tree blame attributes each line to the commit that last changed it

Blame of a file's working-tree version SHALL attribute every unchanged line to the commit
that last changed it, and SHALL mark added or edited lines as uncommitted, whatever lines
were inserted or removed above them.

#### Scenario: Line inserted at the top of a file
- **WHEN** the user inserts one line at the top of a committed file and opens its blame without a revision
- **THEN** the new line is marked uncommitted and every line below keeps its own commit and author

### Requirement: A failed stacked-review file list is shown as an error

When the stacked review cannot read its file list, it SHALL show the error with a Retry
action, like the compare and file-history views, and never "No changes."

#### Scenario: Commit file list read fails
- **WHEN** the file list read for a stacked review of a commit fails
- **THEN** the review shows the error and a Retry button, and Retry reloads the list

### Requirement: The compare view pairs a renamed file with its source

When a file was renamed between the two sides of a comparison, the single-file diff in the compare view SHALL show the change against the rename source, matching the file list's counts. It MUST NOT show the file as entirely added.

#### Scenario: Pure rename between two refs
- **WHEN** the user compares two refs where `a.txt` was moved to `b.txt` without edits and opens `b.txt`
- **THEN** the diff shows a rename with no added or removed lines

#### Scenario: Rename with edits
- **WHEN** the moved file also changed three lines
- **THEN** the diff shows only those three changed lines against the old blob
