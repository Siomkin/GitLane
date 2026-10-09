# Spec Delta

## ADDED Requirements

### Requirement: Working-tree blame attributes each line to the commit that last changed it

Blame of a file's working-tree version SHALL attribute every unchanged line to the commit
that last changed it, and SHALL mark added or edited lines as uncommitted, whatever lines
were inserted or removed above them.

#### Scenario: Line inserted at the top of a file
- **WHEN** the user inserts one line at the top of a committed file and opens its blame without a revision
- **THEN** the new line is marked uncommitted and every line below keeps its own commit and author
