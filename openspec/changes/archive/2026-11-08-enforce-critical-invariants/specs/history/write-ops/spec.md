# Spec Delta

## ADDED Requirements

### Requirement: A live git process keeps the index lock from being removed

GitLane MUST NOT remove `index.lock` while a non-daemon `git` process is running, even when the lock is old and no process has it open. If this cannot be determined, the lock MUST be treated as live.

#### Scenario: A pre-commit hook is running

- **WHEN** a `git commit -a` in a terminal is running a pre-commit hook that outlasts the staleness threshold and the user chooses to remove the lock in GitLane
- **THEN** the lock is left in place and the user is told a git process is still running

#### Scenario: A genuinely stranded lock

- **WHEN** an old `index.lock` exists, no process has it open, and no git process is running
- **THEN** the lock can be removed and the operation retried

#### Scenario: The process check fails

- **WHEN** the running-process check cannot complete
- **THEN** the lock is left in place

### Requirement: A branch held by an operation in progress is not deleted or rewritten

Deleting a local branch and squashing on another local branch MUST be refused when any worktree has that branch checked out, being rebased, or being bisected.

#### Scenario: Deleting a branch paused in a rebase

- **WHEN** a branch is paused in a rebase conflict, so its worktree's HEAD is detached, and the user deletes the branch
- **THEN** the deletion is refused with a message naming the rebase and the worktree, and the rebase can still continue

#### Scenario: Squashing a branch being bisected

- **WHEN** a branch is the starting point of a bisect in a worktree and the user squashes commits on it from elsewhere
- **THEN** the squash is refused and the branch is unchanged

### Requirement: A pull integrates only the commit fetched for the requested ref

A pull MUST fast-forward to the commit recorded for the requested remote ref when its fetch completed, and MUST fail without moving the branch when that record is absent.

#### Scenario: A tag fetch lands between fetch and merge

- **WHEN** another process writes `FETCH_HEAD` with tag entries while a pull is between its fetch and its merge
- **THEN** the branch is not fast-forwarded to a tag commit

#### Scenario: The requested ref is not recorded

- **WHEN** `FETCH_HEAD` has no entry for the requested ref after the fetch
- **THEN** the pull fails with an error and the branch does not move

### Requirement: A merge integrates exactly the commit that was validated

A merge MUST integrate the commit the user confirmed, even if the source ref moves afterwards. The generated merge message MUST be the one git would generate for that source.

#### Scenario: The source ref moves after validation

- **WHEN** a remote-tracking source advances after GitLane validates it and before the merge runs
- **THEN** the merge commit's second parent is the validated commit

#### Scenario: Merge subject and merge.log

- **WHEN** the user merges a branch named `feature` with `merge.log` enabled
- **THEN** the subject is `Merge branch 'feature'` and the body contains the log exactly once

#### Scenario: Merging a raw commit

- **WHEN** the user merges a commit that is not a branch tip by its commit id
- **THEN** the subject is `Merge commit '<id>'`
