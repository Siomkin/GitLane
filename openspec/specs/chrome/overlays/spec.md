## Purpose

Defines the transient overlays that live in the window chrome outside any repository view — starting with the title-bar appearance menu that lets the user pick how the app is themed.

## Requirements

### Requirement: Title-bar appearance menu offers all three theme preferences

The title bar SHALL expose an appearance control that opens a menu listing exactly three options: **Auto** (follow the operating system), **Light**, and **Dark**. Choosing an option SHALL set the app's theme preference to that value, apply it immediately, and close the menu. The option matching the current preference SHALL be visibly marked as selected.

#### Scenario: Selecting Auto from an explicit theme

- **WHEN** the preference is Dark and the user opens the appearance menu and chooses Auto
- **THEN** the preference becomes Auto, the app paints according to the OS colour scheme, and the menu closes

#### Scenario: Selecting an explicit theme

- **WHEN** the user opens the appearance menu and chooses Light
- **THEN** the app paints light regardless of the OS colour scheme, the preference persists across restarts, and the menu closes

#### Scenario: Current preference is marked

- **WHEN** the preference is Auto and the user opens the appearance menu
- **THEN** the Auto option is marked selected and Light and Dark are not

### Requirement: Appearance trigger reflects the stored preference

The title-bar trigger SHALL show which preference is stored — a distinct "auto" glyph for Auto, a sun for Light, a moon for Dark — rather than the resolved paint mode. Opening the menu SHALL never change the preference by itself.

#### Scenario: Auto on a dark OS

- **WHEN** the preference is Auto and the OS colour scheme is dark
- **THEN** the app paints dark and the trigger shows the auto glyph, not the moon

#### Scenario: Opening and dismissing changes nothing

- **WHEN** the user opens the appearance menu and then clicks outside it or presses Escape
- **THEN** the menu closes and the preference is exactly what it was before

### Requirement: Appearance menu and Settings stay in sync

The title-bar appearance menu and the Settings → General Appearance control SHALL read and write the same preference, so a choice made in either place is reflected in the other without reload.

#### Scenario: Change in Settings shows in the title bar

- **WHEN** the user sets Appearance to Auto in Settings → General
- **THEN** the title-bar trigger shows the auto glyph and the menu marks Auto selected

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

### Requirement: Escape closes the topmost open layer

When a dialog is open above the branch navigator, pressing Escape SHALL close that dialog and leave the navigator open. The navigator's outside-click and Escape dismissal MUST be suspended while any dialog is open, not only a fixed subset of dialogs.

#### Scenario: Delete-worktree dialog raised from the navigator
- **WHEN** the user opens "Delete ‹branch› & worktree…" from a navigator row and presses Escape
- **THEN** the dialog closes and the navigator is still open

#### Scenario: Hand-off dialog raised from the navigator
- **WHEN** the user opens "Hand off to…" from a navigator row and presses Escape
- **THEN** the hand-off dialog closes and the navigator is still open

### Requirement: A failing overlay is contained to that overlay

When a dialog, context menu or other globally mounted overlay fails while rendering, only that overlay SHALL be replaced, with an error card that names the failure and offers Close. The title bar, toolbar, workspace and other overlays SHALL stay rendered and usable. Close SHALL dismiss the failed overlay, and reopening it SHALL try again from scratch.

#### Scenario: Dialog crashes on open

- **WHEN** the user opens a dialog and it throws while rendering
- **THEN** an error card replaces that dialog, and the graph, title bar and toolbar stay visible and interactive

#### Scenario: Closing the error card

- **WHEN** the user clicks Close on an overlay's error card
- **THEN** the card disappears, the overlay counts as closed, and opening it again renders it fresh

#### Scenario: Escape closes the error card

- **WHEN** an overlay's error card is the most recently opened overlay and the user presses Escape
- **THEN** the card closes as the overlay itself would have

### Requirement: A failing PR list is contained to the PR list

In PRs mode, if the docked pull-request list fails while rendering, only that panel SHALL show an error card with Retry. The selected pull request's detail view and the window chrome SHALL stay rendered.

#### Scenario: PR list crashes

- **WHEN** the PR list panel throws while rendering
- **THEN** the panel shows an error card with Retry, and the PR detail and toolbar stay visible

### Requirement: The window is never left blank by a render error

If a render error escapes every narrower boundary, the window SHALL show a full-window error screen that says GitLane hit an error and offers Reload. Reload SHALL reload the interface without quitting the app.

#### Scenario: Error outside every narrower boundary

- **WHEN** a component outside any narrower boundary throws while rendering
- **THEN** the window shows the error screen with Reload instead of an empty background

### Requirement: Frontend render errors are recorded locally

Every render error, whether contained or uncaught, SHALL be appended to a log file in the OS's per-user application log directory, with its message, stack and component stack. Release builds SHALL do this too. Credentials in URLs SHALL be redacted before anything is written. The file SHALL stay under a fixed size cap. Nothing SHALL be sent off the machine.

#### Scenario: Release build records a crash

- **WHEN** a dialog crashes in a release build
- **THEN** a timestamped entry with the error message, stack and component stack is appended to the GitLane frontend error log

#### Scenario: URL credentials are redacted

- **WHEN** an error message contains `https://user:secret@host/repo.git`
- **THEN** the logged entry shows the URL with its password replaced by `***`

#### Scenario: Log stays bounded

- **WHEN** appending an entry would push the log file past its size cap
- **THEN** older content is dropped so the file stays under the cap and the newest entry is kept

#### Scenario: Logging failure is silent

- **WHEN** the log file cannot be written
- **THEN** the app keeps running and shows no extra error for the failed write
