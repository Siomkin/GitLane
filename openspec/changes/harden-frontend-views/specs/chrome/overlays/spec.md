# Spec Delta

## ADDED Requirements

### Requirement: Escape closes only the topmost layer, including the onboarding overlay

One Escape keypress SHALL close only the most recently opened dialog or overlay. The
onboarding overlay takes part in the same order as modal dialogs.

#### Scenario: Settings opened from a clone error
- **WHEN** the onboarding overlay shows a clone error, the user opens Accounts settings from it, and presses Escape
- **THEN** Settings closes and the clone-error screen is still shown

#### Scenario: Settings opened during a clone
- **WHEN** a clone is in progress in the onboarding overlay, the user presses ⌘, and then Escape
- **THEN** Settings closes and the clone keeps running

### Requirement: Search and the Graph button reach the graph from any view

The title-bar Search and the stacked review's "Graph" button SHALL show the commit graph
whatever center view is open.

#### Scenario: Search from a stacked review
- **WHEN** a stacked review is open and the user clicks Search in the title bar
- **THEN** the history view is shown with the search bar open

#### Scenario: Graph button over a file view
- **WHEN** a stash's "View changes" was opened while a repository file was showing, and the user clicks "Graph"
- **THEN** the commit graph is shown, not the file view

### Requirement: Keyboard shortcuts match the physical key

The file editor's save shortcut SHALL match by physical key and modifier like every
registry shortcut.

#### Scenario: Russian keyboard layout
- **WHEN** the active layout is Russian and the user presses ⌘S in the file editor with unsaved changes
- **THEN** the file is saved
