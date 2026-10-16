# Spec Delta

## ADDED Requirements

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
