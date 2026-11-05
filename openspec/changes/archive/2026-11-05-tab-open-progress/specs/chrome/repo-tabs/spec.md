## ADDED Requirements

### Requirement: Opening a repository is acknowledged at once

When the user asks to open a repository that has a tab, by any route (tab click, tab shortcut, recents, session restore), that tab SHALL be marked busy until the open ends, and SHALL show a busy indicator in place of its icon once the open has been pending for a brief delay (~200 ms). The repository already on screen SHALL stay on screen, uncleared, while the open is pending.

#### Scenario: Clicking a tab is acknowledged at once

- **WHEN** the user clicks an inactive repository tab
- **THEN** that tab shows a busy indicator within the brief delay, before the repository has opened
- **AND** the previously active repository stays on screen until the clicked one is shown

#### Scenario: A fast local switch does not blink the tab

- **GIVEN** a local repository that opens within the brief delay
- **WHEN** the user clicks its tab
- **THEN** the tab keeps its repository icon throughout and never shows the busy indicator

#### Scenario: An SSH tab names the connection phase

- **GIVEN** an SSH repository tab whose host connection is being re-established
- **WHEN** the user hovers the busy tab
- **THEN** its tooltip reads that it is connecting to that host, or that GitLane's agent is being installed with its progress

### Requirement: A slow open shows a workspace overlay

If an open is still pending after a short delay, the main workspace SHALL show a loading overlay naming the repository being opened; an open that finishes within the delay SHALL NOT show it. For a repository over SSH the overlay SHALL name the connection's current phase instead of a generic "Opening". The tab strip SHALL stay usable while the overlay is shown.

#### Scenario: A fast local open does not flash the overlay

- **GIVEN** a local repository that opens in well under the overlay delay
- **WHEN** the user clicks its tab
- **THEN** the workspace switches to it without the loading overlay ever appearing

#### Scenario: A slow SSH open names what it is doing

- **GIVEN** an SSH repository tab whose host connection has to be re-established
- **WHEN** the user clicks the tab and the open takes longer than the overlay delay
- **THEN** the workspace shows a loading overlay reading that it is connecting to that host
- **AND** if GitLane's agent has to be installed, the overlay shows the install stage and percent as it progresses

### Requirement: Open progress ends with the open

The busy indicator and the overlay SHALL clear when the repository is shown, when the open fails, when a newer open supersedes it, or when the pending tab is closed. Only the latest open SHALL be shown as pending, and an earlier open finishing late SHALL NOT clear it.

#### Scenario: A failed open clears the progress

- **WHEN** a pending open fails
- **THEN** the busy indicator and the overlay disappear
- **AND** the failure is shown where it is shown today: the error bar, the missing-repository screen, or that screen's disconnected state with Reconnect for an unreachable SSH host

#### Scenario: A newer open supersedes a pending one

- **GIVEN** an open of tab A is still pending
- **WHEN** the user clicks tab B
- **THEN** only tab B shows the busy indicator, and the overlay (if shown) names B
- **AND** tab A's open finishing or failing later does not clear B's indicator or overlay

#### Scenario: Closing the pending tab

- **GIVEN** an open of a tab is still pending
- **WHEN** the user closes that tab
- **THEN** the busy indicator and the overlay disappear, and the open does not re-add the tab
