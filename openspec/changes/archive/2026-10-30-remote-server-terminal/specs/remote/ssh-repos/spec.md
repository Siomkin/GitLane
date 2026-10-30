# Spec Delta

## MODIFIED Requirements

### Requirement: Features unavailable on remote repositories are disabled up front

For a remote repository, GitLane SHALL disable or hide pull-request views, file editing in the file workspace, reveal-in-file-manager, open-in-local-editor and AI agent sessions, including the actions that start a terminal agent or hand text to one, and SHALL say they are unavailable for remote repositories. Viewing files read-only and the integrated terminal SHALL remain available.

#### Scenario: Terminal on a remote tab

- **WHEN** the active tab is a remote repository
- **THEN** the terminal action is enabled, the terminal shows no agent launch buttons, and Commit with agent and handing review comments to an agent are disabled with a tooltip saying they are unavailable for remote repositories

#### Scenario: Viewing a file

- **WHEN** the user opens a file in a remote repository's file workspace
- **THEN** its source is shown read-only, with no edit or save actions

## ADDED Requirements

### Requirement: A remote tab's terminal opens on the server

For a remote repository, the integrated terminal SHALL open the user's login shell on the repository's server, in the open worktree's directory. It SHALL connect with the user's installed `ssh`, using the same host, user, port and saved key file as the tab's connection. When that directory does not exist, the terminal SHALL show the shell's error and end. Text typed or pasted into it SHALL reach the remote shell unchanged.

#### Scenario: Opening a terminal on a remote tab

- **WHEN** the active tab is `ssh://devbox/srv/app` and the user opens the terminal
- **THEN** a login shell runs on `devbox` with `/srv/app` as its working directory

#### Scenario: Saved key file

- **WHEN** the tab's saved connection names a key file and the user opens a terminal
- **THEN** the terminal's `ssh` authenticates with that key file only

#### Scenario: Directory removed on the server

- **WHEN** `/srv/app` no longer exists on `devbox` and the user opens a terminal for that tab
- **THEN** the terminal shows the shell's error and ends, and no shell is left running on `devbox`

#### Scenario: Pasted escape sequence

- **WHEN** the user pastes text containing a line that starts with `~.` into a remote terminal
- **THEN** the text reaches the shell and the connection stays open

### Requirement: A remote terminal's ssh questions are answered in the terminal

When a remote terminal's `ssh` asks for a password, passphrase or one-time code, the question SHALL appear in that terminal and the user SHALL answer it there. GitLane SHALL NOT answer it, store it, log it, or show it in the SSH prompt dialog.

#### Scenario: Password-only server

- **WHEN** the server accepts only password authentication and the user opens a terminal
- **THEN** the terminal shows `ssh`'s password prompt, and the shell starts once the correct password is typed into the terminal

#### Scenario: Key in the running agent

- **WHEN** the user's ssh-agent holds a key the server accepts
- **THEN** the terminal's shell starts without any prompt

### Requirement: A remote terminal is independent of the tab's connection

Each remote terminal SHALL use its own SSH connection. Output in a terminal SHALL NOT delay the tab's git operations, and losing the tab's connection SHALL NOT end an open terminal.

#### Scenario: Continuous output

- **WHEN** a terminal on `devbox` prints output continuously
- **THEN** history, status and diff reads for the tab keep completing without waiting for it

#### Scenario: Tab connection lost

- **WHEN** the tab's connection to `devbox` drops while a terminal is open and the server stays reachable
- **THEN** the terminal's shell is not ended, and it is still there once the tab reconnects
