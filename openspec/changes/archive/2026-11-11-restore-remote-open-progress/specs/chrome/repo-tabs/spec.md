# Spec Delta

## ADDED Requirements

### Requirement: Launch restore shows the restored tab's open progress

When GitLane relaunches and reopens the last active repository, the screen SHALL say what it is waiting on once that open has started: the repository's name and, for a repository over SSH, the host and the connection's phase (connecting, installing the agent with its stage and percent) when one is known. It SHALL offer a Cancel that abandons that open. A generic restoring message SHALL be shown only before the open starts.

#### Scenario: A restored SSH tab names its host and phase

- **GIVEN** GitLane was quit with an SSH repository as the active tab
- **WHEN** GitLane relaunches and the host connection is being established
- **THEN** the screen names the repository and the host and says it is connecting to that host, instead of a generic restoring message
- **AND** if GitLane's agent has to be installed, the screen shows the install stage and percent as it progresses

#### Scenario: Cancelling a slow restore

- **GIVEN** GitLane is relaunching into an SSH repository whose host has not answered yet
- **WHEN** the user chooses Cancel on the restoring screen
- **THEN** the welcome screen is shown with the restored tabs still in the tab strip
- **AND** the open finishing or failing later changes nothing on screen

#### Scenario: A restore that fails still lands on the failure

- **GIVEN** GitLane is relaunching into an SSH repository whose host is unreachable
- **WHEN** the open fails
- **THEN** the disconnected state with Reconnect is shown, as for any failed SSH open

#### Scenario: A local restore is unchanged

- **GIVEN** GitLane was quit with a local repository as the active tab
- **WHEN** GitLane relaunches
- **THEN** the repository is shown without a Cancel ever appearing for an open that finishes quickly
