# chrome/software-update Specification

## Purpose

How GitLane offers a newer build: when the update indicator appears, how a user skips a
version, and how the user sees what the versions between theirs and the offered one changed.

## Requirements

### Requirement: A user can skip an offered version

While an update is offered, GitLane SHALL let the user skip that exact version. The choice MUST persist across restarts. A skip applies only to the version string skipped. A download that is in progress or already installed MUST NOT be skippable.

#### Scenario: Skipping from the What's new dialog
- **GIVEN** version 2.5.0 is offered
- **WHEN** the user chooses "Skip this version"
- **THEN** the dialog closes and the titlebar update indicator disappears

#### Scenario: The skip survives a restart
- **GIVEN** the user skipped 2.5.0
- **WHEN** GitLane is relaunched
- **THEN** 2.5.0 is still skipped

#### Scenario: No skip while downloading or installed
- **WHEN** an update is downloading or is installed and waiting for a relaunch
- **THEN** no "Skip this version" action is offered

### Requirement: The launch check stays silent about a skipped version

When the automatic launch check finds a version the user skipped, GitLane MUST NOT show the update indicator or any notice. The check MUST count as finding nothing to install, so the next automatic check waits for the usual daily interval. The About card MUST NOT claim GitLane is up to date in this case.

#### Scenario: Launch check finds the skipped version
- **GIVEN** the user skipped 2.5.0 and 2.5.0 is still the newest release on their channel
- **WHEN** the launch check runs
- **THEN** no update indicator appears
- **AND** the next automatic check runs no sooner than a day later

#### Scenario: About card after a silent skip
- **GIVEN** the launch check found the skipped version
- **WHEN** the user opens Settings → About
- **THEN** the card offers "Check for updates" and does not say "You're up to date"

### Requirement: A newer release replaces the skip

A skip MUST NOT hide any version other than the one skipped. When the launch check finds a different version, GitLane SHALL offer it as usual, with no action needed from the user.

#### Scenario: A release after the skipped one
- **GIVEN** the user skipped 2.5.0
- **WHEN** the launch check finds 2.5.1
- **THEN** the update indicator appears offering 2.5.1

### Requirement: A manual check always shows the skipped version

A check the user starts from Settings → About MUST offer the newest version even if it was skipped. It SHALL mark that version as skipped and SHALL let the user install it. After that manual check, the update stays offered, indicator included, for the rest of the session.

#### Scenario: Manual check after skipping
- **GIVEN** the user skipped 2.5.0
- **WHEN** the user clicks "Check for updates" in Settings → About
- **THEN** the card offers 2.5.0, labelled as a version they skipped, with "Install update" available

### Requirement: The update indicator opens the What's new dialog

Clicking the titlebar update indicator SHALL open the What's new dialog, not Settings → About. The dialog SHALL show the action that fits the update's state: Install, Skip this version or Later while offered; download progress while downloading; Relaunch once installed; Retry download after a failed download.

#### Scenario: Opening an offered update
- **GIVEN** version 2.5.0 is offered
- **WHEN** the user clicks the titlebar update indicator
- **THEN** the What's new dialog opens showing 2.5.0 with "Install update", "Skip this version" and "Later"

#### Scenario: Later keeps the update offered
- **WHEN** the user chooses "Later" in the What's new dialog
- **THEN** the dialog closes and the update indicator stays visible

#### Scenario: Installed update waiting for relaunch
- **GIVEN** the update finished installing
- **WHEN** the user opens the What's new dialog
- **THEN** it offers "Relaunch" and no install or skip action

#### Scenario: Escape closes the dialog
- **WHEN** the What's new dialog is open and the user presses Escape
- **THEN** the dialog closes and the update stays offered

### Requirement: Release notes cover every version up to the offered one

The What's new dialog and the About card SHALL list each release newer than the running version, up to and including the offered one, newest first. The stable channel MUST leave out pre-releases and the beta channel MUST include them. The list MUST show at most ten versions, then link to the full release list on GitHub.

#### Scenario: Stable user two releases behind
- **GIVEN** a stable-channel user runs 2.4.1 and 2.4.3 is offered
- **WHEN** the What's new dialog opens
- **THEN** it lists 2.4.3 and then 2.4.2, each with its notes, and no pre-release

#### Scenario: Beta user
- **GIVEN** a beta-channel user runs 2.5.0-beta.1 and 2.5.0-beta.2 is offered
- **WHEN** the What's new dialog opens
- **THEN** it lists 2.5.0-beta.2

#### Scenario: More than ten versions behind
- **WHEN** more than ten releases fall in the range
- **THEN** the ten newest are listed, followed by a link to the GitHub Releases page

### Requirement: Release notes render as safe markdown without installer boilerplate

Each version's notes SHALL render as markdown under the same sanitizing and external-link rules as PR descriptions. The fixed download-page line and the "macOS build is unsigned" footer MUST NOT be shown. A release with no notes left SHALL show its version with "No release notes".

#### Scenario: Notes with a link
- **WHEN** a release's notes contain a link and the user clicks it
- **THEN** it opens in the system browser and the app window does not navigate

#### Scenario: Boilerplate removed
- **WHEN** a release body starts with "Desktop builds for GitLane. Not sure which file to download?…"
- **THEN** that line does not appear in the rendered notes

### Requirement: Release notes failing to load never blocks updating

Release notes MUST load only when the What's new dialog or the About card is shown with an offered update, at most once per offered version per session. If they fail to load, the update SHALL stay installable and the indicator SHALL stay as it was. The notes area SHALL say the notes could not be loaded and link to the GitHub Releases page.

#### Scenario: Offline when opening the dialog
- **GIVEN** version 2.5.0 is offered and the release-notes request fails
- **WHEN** the What's new dialog opens
- **THEN** it says the release notes could not be loaded, links to GitHub Releases, and "Install update" still works

#### Scenario: Notes are fetched once
- **GIVEN** the notes for the offered version loaded
- **WHEN** the user closes and reopens the What's new dialog
- **THEN** no new release-notes request is made
