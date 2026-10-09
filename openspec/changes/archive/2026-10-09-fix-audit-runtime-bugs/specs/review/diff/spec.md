# Spec Delta

## ADDED Requirements

### Requirement: The compare view pairs a renamed file with its source

When a file was renamed between the two sides of a comparison, the single-file diff in the compare view SHALL show the change against the rename source, matching the file list's counts. It MUST NOT show the file as entirely added.

#### Scenario: Pure rename between two refs
- **WHEN** the user compares two refs where `a.txt` was moved to `b.txt` without edits and opens `b.txt`
- **THEN** the diff shows a rename with no added or removed lines

#### Scenario: Rename with edits
- **WHEN** the moved file also changed three lines
- **THEN** the diff shows only those three changed lines against the old blob
