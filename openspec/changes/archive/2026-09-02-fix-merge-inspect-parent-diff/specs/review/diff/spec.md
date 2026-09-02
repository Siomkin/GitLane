## Purpose

Lets someone inspecting a merge commit see the files that came from either parent, so merging mainline into a feature does not look like a hundred-file change set.

## ADDED Requirements

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
