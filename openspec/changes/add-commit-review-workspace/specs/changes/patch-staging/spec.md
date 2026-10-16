# Spec Delta

## ADDED Requirements

### Requirement: A contiguous line range stages or unstages as one operation

When the user stages or unstages a contiguous range of changed lines, GitLane MUST apply the whole
range in one operation: either every selected change moves or none does. Each line MUST land at the
position it occupies relative to the index content, as for a single line.

#### Scenario: Stage a three-line block with another change above it
- **WHEN** a file has an unstaged insertion near the top and an unstaged three-line replacement lower down, and the user stages only the replacement
- **THEN** the index contains the three replacement lines at their intended position
- **AND** the insertion near the top remains unstaged

#### Scenario: The range spans removed and added lines
- **WHEN** the selected range replaces two removed lines with three added lines
- **THEN** the index shows the two lines removed and the three added, and nothing else changes

#### Scenario: One line of the range is stale
- **WHEN** any line in the selected range no longer matches the file
- **THEN** GitLane refuses the whole operation and asks the user to refresh
- **AND** the index is unchanged

### Requirement: An unstaged line range can be reverted in the working tree

GitLane MUST let the user restore a contiguous range of unstaged changes in a working-tree file to
the index content. Only the selected range MUST change. The index and every other change in the
file MUST stay as they were, and the revert MUST keep the byte-for-byte guarantee of partial staging.

#### Scenario: Revert the lower of two unstaged blocks
- **WHEN** a file has two unstaged blocks and the user reverts the lower one
- **THEN** the working-tree file keeps the upper block and loses the lower one
- **AND** the index is unchanged

#### Scenario: CRLF file
- **WHEN** the user reverts a block in a file whose lines end with CR LF
- **THEN** every remaining line still ends with CR LF

#### Scenario: Range includes staged content
- **WHEN** the requested range overlaps a change that is staged
- **THEN** GitLane refuses and modifies neither the index nor the working tree

### Requirement: A working-tree revert refuses stale selections

If the working-tree file changed between the diff the user is looking at and the moment a revert
runs, GitLane MUST refuse and ask the user to refresh. It MUST NOT apply the revert to a position
it cannot confirm.

#### Scenario: File edited after the diff was shown
- **WHEN** an editor saves the file after GitLane rendered its diff and the user then reverts a block
- **THEN** GitLane reports that the file changed and asks the user to refresh
- **AND** the working-tree file is unchanged
