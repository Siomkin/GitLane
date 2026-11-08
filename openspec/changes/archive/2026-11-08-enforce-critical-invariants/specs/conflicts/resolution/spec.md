# Spec Delta

## ADDED Requirements

### Requirement: Aborting a carry never destroys work outside the recovery stashes

When HEAD differs from where a worktree-handoff carry was applied, aborting it MUST end the carry without changing any file and MUST keep the recovery stashes. Otherwise aborting MUST save the tracked and staged worktree content to a named stash before discarding it, including when conflicts are unresolved.

#### Scenario: HEAD moved since the carry

- **WHEN** a carry marker is still active, the user has since moved HEAD, and the user aborts the carry
- **THEN** the carry ends, no file changes, and the recovery stashes remain

#### Scenario: Edits made after the carry

- **WHEN** the user edited tracked files after the carry and then aborts it
- **THEN** the worktree returns to HEAD and those edits are available in a stash named as a carry abort backup

#### Scenario: A file staged after the carry

- **WHEN** the user staged a new file after the carry and then aborts it
- **THEN** that file is available in the backup stash

#### Scenario: Unresolved conflicts at abort

- **WHEN** the carry still has unmerged files and the user aborts it
- **THEN** the abort succeeds and the backup stash holds the conflicted content

#### Scenario: Nothing to back up

- **WHEN** tracked files already match HEAD and the user aborts the carry
- **THEN** no backup stash is created

#### Scenario: The confirmation is accurate

- **WHEN** the abort confirmation is shown
- **THEN** it states that tracked changes are saved to a backup stash before being discarded
