# Spec Delta

## ADDED Requirements

### Requirement: The working-changes count counts each file once

The Working Changes header SHALL count a file with both staged and unstaged changes once,
matching the Changes workspace and the toolbar badge.

#### Scenario: Partly staged file
- **WHEN** one file has a staged hunk and an unstaged hunk and nothing else changed
- **THEN** the header, the Changes workspace and the toolbar badge each report one change
