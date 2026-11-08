# repo-files/editor Specification

## Purpose

Protects unsaved edits in the repository file editor so that no user action discards a draft without confirmation.

## Requirements

### Requirement: A dirty editor draft is dropped only after the user confirms

When the file editor holds unsaved changes, every user-initiated action that would leave the editor MUST ask for confirmation before discarding the draft. Declining MUST leave the editor and its draft unchanged.

#### Scenario: Switching repository tabs

- **WHEN** the editor has unsaved changes and the user selects another repository tab by clicking it or using a tab shortcut
- **THEN** a discard confirmation appears and the tab does not change until the user confirms

#### Scenario: Switching worktrees

- **WHEN** the editor has unsaved changes and the user switches to or adds a worktree
- **THEN** a discard confirmation appears before the switch

#### Scenario: Selecting elsewhere in the same repository

- **WHEN** the editor has unsaved changes and the user selects a changed file, a commit, the working tree, a comparison, or a file history
- **THEN** a discard confirmation appears before the editor closes

#### Scenario: Declining keeps the draft

- **WHEN** the discard confirmation is showing and the user declines
- **THEN** the editor remains open with the typed text intact

#### Scenario: Closing the active repository tab

- **WHEN** the editor has unsaved changes and the user closes that repository's tab
- **THEN** a discard confirmation appears before the tab closes

#### Scenario: Closing a background tab

- **WHEN** the editor has unsaved changes and the user closes a different repository's tab
- **THEN** no confirmation appears and the draft is unchanged

#### Scenario: Automatic reselection keeps the editor open

- **WHEN** the editor is open and the Details panel opens or the user stages a file in the right panel
- **THEN** the editor stays open with its draft intact

#### Scenario: No unsaved changes

- **WHEN** the editor has no unsaved changes and the user navigates away
- **THEN** no confirmation appears

### Requirement: Leaving the app with a dirty draft requires confirmation

Closing the window, using the app's Quit command from the menu or its shortcut, and restarting to install an update MUST ask for confirmation while the editor holds unsaved changes.

#### Scenario: Quit with unsaved changes

- **WHEN** the editor has unsaved changes and the user closes the window or uses Quit from the menu or its shortcut
- **THEN** a discard confirmation appears and the app stays open until the user confirms

#### Scenario: Restart for an update

- **WHEN** the editor has unsaved changes and the user chooses to restart for an update
- **THEN** a discard confirmation appears before the restart
