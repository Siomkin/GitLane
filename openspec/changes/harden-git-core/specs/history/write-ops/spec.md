# Spec Delta

## ADDED Requirements

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
