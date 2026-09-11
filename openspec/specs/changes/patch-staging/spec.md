## Purpose

Staging and unstaging individual hunks and lines from a displayed diff must move exactly the change
the user picked, to exactly the position it occupies, without disturbing or reordering any other
pending edit in the same file. This capability covers the correctness contract of partial staging,
which the user cannot verify by eye before committing.

## Requirements

### Requirement: Staging one line places it at the position it occupies in the file

When the user stages or unstages a single added or deleted line, GitLane MUST apply that change at
the position the line occupies relative to the index content being modified, not at the position it
occupies in the rendered diff. The two differ whenever another pending change sits earlier in the
same file, and the difference MUST NOT shift the applied line.

#### Scenario: Another unstaged insertion sits above the staged line

- **WHEN** a file is committed as ten lines, the user inserts one line after line 2 and another after
  line 7, and stages only the second insertion
- **THEN** the staged content contains that line immediately after line 7
- **AND** the remaining unstaged change is still the first insertion, unchanged

#### Scenario: Another unstaged deletion sits above the staged line

- **WHEN** the user deletes a line early in a file and adds a line later in the same file, and stages
  only the addition
- **THEN** the staged content contains the added line at its intended position
- **AND** the early deletion remains unstaged

#### Scenario: Unstaging one line from a multi-change staged file

- **WHEN** several changes are staged in one file and the user unstages a single line that is not the
  first of them
- **THEN** only that line returns to the working tree
- **AND** every other staged change keeps its original position in the index

### Requirement: A partial-staging patch is applied byte-for-byte

GitLane MUST apply the exact bytes of the patch it derived from the file. Content that is not valid
UTF-8, lines ending in CR, and trailing whitespace MUST survive the round trip unaltered, and
diagnostic output from git MUST NOT be mixed into the patch.

#### Scenario: A line in a file with CRLF endings is staged

- **WHEN** the user stages one added line in a file whose lines end with CR LF
- **THEN** the staged blob keeps the CR on every line, including the last one

#### Scenario: A file contains bytes that are not valid UTF-8

- **WHEN** the user stages a hunk from a file containing a non-UTF-8 byte sequence
- **THEN** the staged blob contains the original bytes
- **AND** GitLane never substitutes a replacement character

#### Scenario: git emits a warning while the patch is produced

- **WHEN** the user's configuration makes git write a line-ending warning while the diff is generated
- **THEN** the warning does not enter the patch
- **AND** the staging operation succeeds

### Requirement: Partial staging refuses stale selections instead of guessing

If the file changed between the diff the user is looking at and the moment the operation runs,
GitLane MUST refuse the operation and ask the user to refresh. It MUST NOT apply the patch to a
position it cannot confirm.

#### Scenario: The selected line changed on disk

- **WHEN** the user stages a line whose content or line number no longer matches the displayed diff
- **THEN** GitLane reports that the line changed and asks the user to refresh
- **AND** neither the index nor the working tree is modified

#### Scenario: A context line is selected

- **WHEN** the selection resolves to an unchanged context line
- **THEN** GitLane refuses the operation and explains that context lines cannot be staged alone
