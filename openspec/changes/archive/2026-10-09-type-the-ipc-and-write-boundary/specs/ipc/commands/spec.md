# Spec Delta

## ADDED Requirements

### Requirement: Closed-set command arguments reject unknown values

A command argument that names one of a fixed set of choices SHALL be rejected at the command boundary when it holds a value outside that set. This covers merge methods, PR state actions, reset modes, and in-progress operation kinds. No provider or write may substitute a default choice for an unknown value.

#### Scenario: Unknown PR state action
- **WHEN** `set_pull_request_state` receives the action `"bogus"`
- **THEN** the command fails with a validation error and the pull request is not closed, reopened, or changed

#### Scenario: Unknown merge method
- **WHEN** a merge is requested with method `"fast"` on any forge
- **THEN** the command fails with a validation error and no merge is performed

### Requirement: libgit2 read failures keep their category

A repository read that fails inside libgit2 SHALL cross IPC with the category derived from the libgit2 error itself, without converting the error to text first. An operating-system error that is not "path not found" MUST NOT be reported as a missing repository.

#### Scenario: Permission denied during a status read
- **WHEN** a working-tree status read fails with a libgit2 OS error caused by a permission problem
- **THEN** the rejection is not `kind: "missingPath"` and the repository tab stays open with an error

#### Scenario: Repository deleted mid-session
- **WHEN** the open repository's folder is deleted and the next read fails
- **THEN** the tab switches to the missing-repository state

### Requirement: Every leased write reports a stale lease as staleLease

Every write guarded by a preview lease SHALL report a changed-since-preview failure as `kind: "staleLease"`. This includes discard-all, hard reset, reset, worktree removal, force-push, branch delete, and hunk or line staging.

#### Scenario: Hard reset after the tree changed
- **WHEN** the user confirms a hard reset after files changed since the preview
- **THEN** the rejection arrives as `kind: "staleLease"`

#### Scenario: Worktree removal after the worktree changed
- **WHEN** the user confirms a worktree removal after the worktree gained new changes
- **THEN** the rejection arrives as `kind: "staleLease"`
