# Spec Delta

## ADDED Requirements

### Requirement: Escape closes the topmost open layer

When a dialog is open above the branch navigator, pressing Escape SHALL close that dialog and leave the navigator open. The navigator's outside-click and Escape dismissal MUST be suspended while any dialog is open, not only a fixed subset of dialogs.

#### Scenario: Delete-worktree dialog raised from the navigator
- **WHEN** the user opens "Delete ‹branch› & worktree…" from a navigator row and presses Escape
- **THEN** the dialog closes and the navigator is still open

#### Scenario: Hand-off dialog raised from the navigator
- **WHEN** the user opens "Hand off to…" from a navigator row and presses Escape
- **THEN** the hand-off dialog closes and the navigator is still open
