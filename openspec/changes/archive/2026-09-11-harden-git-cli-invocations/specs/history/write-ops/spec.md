## ADDED Requirements

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
