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

### Requirement: Toast status is shown by a corner glow and icon

A toast MUST show its status through its status icon and a soft glow in the status colour that starts at the card's top-left corner and fades into the normal card surface. A toast MUST NOT show a coloured strip along its left edge or a countdown bar along its bottom edge. This MUST hold in both the dark and light themes. A progress toast MUST keep its progress track.

#### Scenario: An error toast appears

- **WHEN** an error toast is shown
- **THEN** the card has an error-coloured glow from its top-left corner and the error icon
- **AND** it has no left-edge strip and no bottom countdown bar

#### Scenario: A progress toast appears

- **WHEN** a progress toast is shown
- **THEN** it keeps its progress track and has no left-edge strip

### Requirement: A toast stands out from the window behind it

Every toast MUST be visibly separated from the app surface behind it, in both themes, by a thin neutral border and a shadow. The border MUST NOT take the status colour.

#### Scenario: A toast over the main window

- **WHEN** a toast is shown over the app's background in the dark or light theme
- **THEN** the card's edge is clearly visible against that background

### Requirement: The status icon doubles as the close control

A toast's status icon MUST sit at the card's right edge, and a closable toast MUST NOT reserve separate space for a close button. The status icon MUST act as the close control, showing a close symbol while the pointer is over the card or the control has keyboard focus. An in-flight progress toast MUST NOT offer a close control.

#### Scenario: Hovering a toast

- **WHEN** the pointer moves over a closable toast
- **THEN** its status icon is replaced by a close symbol, and clicking it closes the toast

#### Scenario: Keyboard use

- **WHEN** keyboard focus reaches a toast's close control
- **THEN** the close symbol shows with a focus ring, and activating it closes the toast

#### Scenario: A progress toast is hovered

- **WHEN** the pointer moves over an in-flight progress toast
- **THEN** its icon stays and the toast cannot be closed from it

### Requirement: Toasts close on their own after a window set by their content

A toast with no explicit duration MUST close on its own after 5 seconds for info, success and neutral; 8 seconds for a warning; 10 seconds when it is not an error and has an action; and 12 seconds for an error, with or without an action. An in-flight progress toast MUST stay until its operation resolves it. A duration set explicitly for a toast MUST take precedence over these windows.

#### Scenario: A plain success toast

- **WHEN** a success toast with no action is shown and the pointer stays away
- **THEN** it closes after 5 seconds

#### Scenario: A warning toast

- **WHEN** a warning toast with no action is shown and the pointer stays away
- **THEN** it is still open just before 8 seconds and closes at 8 seconds

#### Scenario: A toast with an action

- **WHEN** a non-error toast with an action and no explicit duration is shown and the pointer stays away
- **THEN** it closes after 10 seconds without the action running

#### Scenario: An error toast

- **WHEN** an error toast is shown and the pointer stays away
- **THEN** it closes after 12 seconds, whether or not it has an action

#### Scenario: An operation is still running

- **WHEN** a progress toast has been shown for longer than every window above
- **THEN** it stays open until its operation resolves it

#### Scenario: A caller sets its own duration

- **WHEN** a toast is shown with an explicit duration
- **THEN** it closes after that duration and not after the default for its kind

### Requirement: Hovering the toast stack holds its countdowns

Once the pointer moves over a toast, every toast countdown MUST pause, and each MUST continue with its remaining time when the pointer leaves. The hold MUST end when the last toast closes, so that closing the last toast under the pointer never prevents later toasts from closing on their own.

#### Scenario: Reading a toast before it closes

- **WHEN** the pointer rests on a toast past the end of its window and then leaves
- **THEN** the toast stays open while hovered and closes after its remaining time

#### Scenario: The last toast is closed under the pointer

- **WHEN** the pointer is over the only toast, the user closes it, and a new toast is shown later
- **THEN** the new toast closes after its own window without being hovered or clicked

#### Scenario: A toast appears under a resting pointer

- **WHEN** a toast appears beneath a pointer that does not move
- **THEN** its countdown runs and it closes after its own window

### Requirement: Countdowns hold while the user is away or working in a toast

Every toast countdown MUST pause while GitLane is not the active window, while keyboard focus is inside the toast stack, and while text inside a toast is selected. Each MUST continue with its remaining time only once none of these holds applies, and a toast raised while the app is in the background MUST start its window when the user returns.

#### Scenario: An operation fails while the user is in another app

- **WHEN** an error toast is raised while GitLane is in the background and the user returns a minute later
- **THEN** the toast is still showing and closes after its full window

#### Scenario: Keyboard focus reaches a toast action

- **WHEN** keyboard focus stays on a toast's action past the end of its window
- **THEN** the toast stays open until focus leaves the stack

#### Scenario: Selecting error text to copy

- **WHEN** the user selects text in a toast and the pointer leaves the stack
- **THEN** the toast stays open until the selection is cleared

### Requirement: A closing toast leaves smoothly

When a toast closes, by its timer, its close button, its action or its operation finishing, the card MUST fade out while moving towards the left edge, and the remaining cards MUST move into the freed space smoothly rather than jumping. A closing card MUST NOT respond to clicks or be announced to assistive technology. When the user has asked for reduced motion, the toast MUST close without this animation.

#### Scenario: The user closes a toast in the middle of the stack

- **WHEN** the user clicks the close button of a toast with cards above and below it
- **THEN** that card fades out to the left in its own position and the stack closes the gap smoothly

#### Scenario: A closing card is clicked

- **WHEN** the user clicks an action on a card that is already closing
- **THEN** the action does not run

#### Scenario: Reduced motion

- **WHEN** the operating system's reduced-motion preference is on and a toast closes
- **THEN** the card and the gap disappear without a sliding or fading transition
