# Spec Delta

## ADDED Requirements

### Requirement: A failed stacked-review file list is shown as an error

When the stacked review cannot read its file list, it SHALL show the error with a Retry
action, like the compare and file-history views, and never "No changes."

#### Scenario: Commit file list read fails
- **WHEN** the file list read for a stacked review of a commit fails
- **THEN** the review shows the error and a Retry button, and Retry reloads the list
