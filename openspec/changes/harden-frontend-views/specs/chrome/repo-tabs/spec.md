# Spec Delta

## ADDED Requirements

### Requirement: Recent worktree entries keep their repository identity across restarts

A recent entry for a linked worktree SHALL keep the repository it belongs to after a
restart. It keeps the repository's display name and group without waiting for a status
probe, and even when its path is currently missing.

#### Scenario: Restart with a worktree in recents
- **WHEN** the user opened a linked worktree of a named, grouped repository and restarts GitLane
- **THEN** the recents list shows that worktree under the repository's group with its name straight away

#### Scenario: Worktree path is missing
- **WHEN** the worktree folder was removed before the restart
- **THEN** its recent row is still grouped under its repository, marked missing
