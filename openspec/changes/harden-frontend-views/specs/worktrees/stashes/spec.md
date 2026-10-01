# Spec Delta

## ADDED Requirements

### Requirement: A failed stash or worktree read on open is shown as unavailable

When opening a repository fails to read its stashes, worktrees, remotes, forge or operation
state, the affected section SHALL be marked unavailable, as a failed refresh marks it. It
SHALL never be shown as empty.

#### Scenario: Stash list fails while opening
- **WHEN** `list_stashes` fails as the repository opens
- **THEN** the navigator's Stashes section says the stash list is unavailable, not that there are no stashes

#### Scenario: A later read succeeds
- **WHEN** the next refresh reads the stashes successfully
- **THEN** the unavailable mark is cleared and the stashes are listed
