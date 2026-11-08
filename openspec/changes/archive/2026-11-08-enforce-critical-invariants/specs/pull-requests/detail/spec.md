# Spec Delta

## ADDED Requirements

### Requirement: A pull-request write reaches the pull request the user selected

Merging, stack merging, linking a stack, approving, closing, reopening, and resolving a review thread MUST NOT reach the provider's write endpoint unless the same number in the repository the write would target resolves to the pull request the user selected.

#### Scenario: The target repository changed under a stale list

- **WHEN** the list shows a fork's pull requests, a terminal checkout makes the parent repository the current target, and the user clicks Merge on a row
- **THEN** no merge happens, and the user is told the list is out of date and asked to refresh

#### Scenario: The list is current

- **WHEN** the number in the target repository resolves to the selected pull request
- **THEN** the write proceeds as before

#### Scenario: The list was loaded after a rename

- **WHEN** the repository was renamed or its remote URL differs from the canonical name only in case, and the selected row was loaded after the rename
- **THEN** the write proceeds

#### Scenario: The list predates a rename

- **WHEN** the repository was renamed after the list was loaded and the user acts on a row from that list
- **THEN** no write happens, and the user is told the list is out of date and asked to refresh

#### Scenario: The pull request cannot be read

- **WHEN** the check cannot read the pull request from the provider
- **THEN** the write does not happen and the error is shown
