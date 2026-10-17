# Spec Delta

## MODIFIED Requirements

### Requirement: Staging-area view keeps staged and unstaged separate

The workspace SHALL open in the Staging-area view, which shows a file's staged changes (HEAD to
index) and unstaged changes (index to working tree) as separate diffs with per-hunk and per-line
stage and unstage actions. The Include view SHALL be an optional view the user switches to.
Switching views SHALL NOT change the index or the working tree.

#### Scenario: Staging area is the default
- **WHEN** the user opens the Changes tab without having picked a view
- **THEN** the Staging-area view is shown, with the staged and unstaged changes listed separately

#### Scenario: Switch views on a partly staged file
- **WHEN** the user switches from the Staging-area view to the Include view on a partly staged file
- **THEN** the file shows one HEAD-to-working-tree diff with its staged difference checked
- **AND** the index and working tree are unchanged
