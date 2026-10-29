# Spec Delta

## Purpose

Lets a user open and work on a git repository that lives on another machine, reached over SSH, with the repository's code and history staying on that machine.

## ADDED Requirements

### Requirement: A remote repository is addressed by an ssh locator

GitLane SHALL open a repository given as `ssh://[user@]host[:port]/<absolute path>`, where `host` is any name the user's `ssh` accepts, including a config alias. The locator SHALL identify the repository everywhere a local path does: tabs, recent repositories and per-repository settings. A locator whose path is relative or starts with `~` SHALL be rejected before connecting.

#### Scenario: Open by config alias

- **WHEN** the user opens `ssh://devbox/srv/app` and `devbox` is a `Host` in their SSH config
- **THEN** GitLane connects using that config entry and opens the repository at `/srv/app` on that machine

#### Scenario: Remote repository is remembered

- **WHEN** the user opens a remote repository, quits, and relaunches GitLane
- **THEN** the repository appears in recent repositories under its locator and reopens on the same host and path

#### Scenario: Relative path rejected

- **WHEN** the user enters `ssh://devbox/~/app` or `ssh://devbox/app`
- **THEN** GitLane rejects the locator with a message asking for an absolute path, and makes no connection

### Requirement: Remote repository content stays on the server

GitLane SHALL NOT copy a remote repository's objects, history or working-tree files to the local disk. Only the results needed for what the user is viewing SHALL be transferred, and they SHALL be held in memory only.

#### Scenario: Browsing history leaves no local copy

- **WHEN** the user browses the history, diffs and files of a remote repository and closes its tab
- **THEN** no repository objects, packfiles or working-tree files from that repository exist on the local disk

### Requirement: The connection uses the user's own SSH setup without prompting

GitLane SHALL connect with the user's installed `ssh` client and its configuration, keys and running agent. It SHALL NOT prompt for passwords, passphrases or one-time codes, and SHALL NOT store any SSH credential. When the server requires interactive authentication, opening SHALL fail with an error saying key or agent authentication is required.

#### Scenario: Key in the running agent

- **WHEN** the user's ssh-agent holds a key the server accepts
- **THEN** the repository opens without any prompt

#### Scenario: Server wants a password

- **WHEN** the server accepts only password authentication
- **THEN** opening fails with an error stating that key-based or agent authentication is required, and no password prompt appears

### Requirement: GitLane never changes SSH host trust

GitLane SHALL NOT accept, add or override host keys. When the server's host key is unknown or does not match, opening SHALL fail with an error naming the host and telling the user to verify it by connecting once from a terminal.

#### Scenario: First connection to an unknown host

- **WHEN** the user opens a repository on a host absent from their known hosts
- **THEN** opening fails with an error naming the host and the terminal step, and the known-hosts file is unchanged

#### Scenario: Changed host key

- **WHEN** the host key on record does not match the server's key
- **THEN** opening fails, and GitLane does not offer to replace the recorded key

### Requirement: The GitLane agent is installed on demand for the app's version

When the server lacks a GitLane agent matching the app's version, GitLane SHALL install it in a per-version directory under the connecting user's home directory, showing progress, before opening the repository. The server SHALL need only sshd and git 2.36.0 or newer. It SHALL NOT need internet access or administrator rights.

#### Scenario: First connection installs the agent

- **WHEN** the user opens a repository on a server with no GitLane agent
- **THEN** GitLane shows install progress, installs the agent under the user's home directory, and then opens the repository

#### Scenario: App update installs a new agent

- **WHEN** the user updates GitLane and reopens a remote repository
- **THEN** GitLane installs the agent for the new version, and the previous version's agent stays in place

#### Scenario: Server git is too old

- **WHEN** the server's git is older than 2.36.0
- **THEN** opening fails with the same unsupported-git error GitLane reports for a local git that is too old

### Requirement: Only a verified agent is installed

GitLane SHALL install an agent binary only after verifying that it is signed with GitLane's release key. When verification fails, GitLane SHALL install nothing and opening SHALL fail with an integrity error.

#### Scenario: Tampered download

- **WHEN** the agent binary obtained for installation fails signature verification
- **THEN** nothing is uploaded to the server, and opening fails with an integrity error

### Requirement: Old agent versions are pruned

After installing an agent, GitLane SHALL remove the agent directories for versions other than the current one and the one immediately before it. It SHALL NOT remove an agent that is currently running.

#### Scenario: Third version installed

- **WHEN** agents for versions 1, 2 and 3 are on the server and version 3 has just been installed
- **THEN** the version 1 directory is removed, and the version 2 and 3 directories remain

### Requirement: Supported server platforms

GitLane SHALL support remote repositories on Linux servers running x86_64 or aarch64. On any other server operating system or architecture, opening SHALL fail with an error naming the detected platform, and nothing SHALL be installed.

#### Scenario: Linux arm64 server

- **WHEN** the user opens a repository on an aarch64 Linux server
- **THEN** the matching agent is installed and the repository opens

#### Scenario: macOS server

- **WHEN** the user opens a repository on a macOS server
- **THEN** opening fails with an error naming the platform as unsupported, and nothing is installed

### Requirement: Git operations behave the same on a remote repository

On a remote repository, GitLane SHALL provide history and graph, history search, commit and range diffs, working-tree status and diffs, staging, commit, branch and tag operations, merge, rebase, cherry-pick, revert, reset, squash, conflict resolution, stash, worktrees, the repository identity card, fetch, pull and push. These SHALL produce the same repository result as on a local repository, with git running on the server.

#### Scenario: Commit on a remote repository

- **WHEN** the user stages a file and commits in a remote repository tab
- **THEN** the commit is created on the server by the server's git, its hooks run on the server, and the graph shows the new commit

#### Scenario: Conflicting rebase

- **WHEN** a rebase in a remote repository stops on a conflict
- **THEN** the conflict workspace opens with the conflicted files from the server, and resolving and continuing completes the rebase on the server

### Requirement: Features unavailable on remote repositories are disabled up front

For a remote repository, GitLane SHALL disable or hide the integrated terminal, pull-request views, file editing in the file workspace, reveal-in-file-manager, open-in-local-editor and AI agent sessions, and SHALL say they are unavailable for remote repositories. Viewing files read-only SHALL remain available.

#### Scenario: Terminal on a remote tab

- **WHEN** the active tab is a remote repository
- **THEN** the terminal action is disabled, and its tooltip says it is unavailable for remote repositories

#### Scenario: Viewing a file

- **WHEN** the user opens a file in a remote repository's file workspace
- **THEN** its source is shown read-only, with no edit or save actions

### Requirement: Remote repositories update live

Changes made on the server outside GitLane SHALL appear in the open remote repository without user action, on the same schedule as local repositories. When the server cannot watch the repository, GitLane SHALL show a non-blocking notice once and SHALL refresh when the window regains focus.

#### Scenario: Commit made in a server shell

- **WHEN** someone commits in the repository from a shell on the server while its tab is open
- **THEN** the new commit appears in the graph without the user refreshing

#### Scenario: Watch limit reached

- **WHEN** the server refuses to watch the repository because of a system watch limit
- **THEN** GitLane shows a single non-blocking notice, and the tab refreshes each time the window regains focus

### Requirement: One connection serves every tab on a host

GitLane SHALL share a single connection to a host among all open repositories on that host. Closing the last repository on a host SHALL close its connection.

#### Scenario: Two repositories on one host

- **WHEN** the user opens `ssh://devbox/srv/a` and `ssh://devbox/srv/b`
- **THEN** both tabs work over one SSH connection to `devbox`

#### Scenario: Last tab closed

- **WHEN** the user closes the last open repository on `devbox`
- **THEN** the connection to `devbox` ends

### Requirement: A lost connection is shown per tab and recoverable

When the connection to a host drops or cannot be made, every tab on that host SHALL show a disconnected state with a reconnect action, and tabs on other hosts or local repositories SHALL be unaffected. After reconnecting, the tab SHALL re-read the repository before allowing further operations.

#### Scenario: Network drop

- **WHEN** the connection to `devbox` drops while two of its repositories are open
- **THEN** both tabs show the disconnected state, and local tabs keep working

#### Scenario: Reconnect

- **WHEN** the user chooses reconnect and the host is reachable
- **THEN** the tab re-reads the repository and returns to its normal view

### Requirement: No secret reaches the server

GitLane SHALL NOT send any provider token, stored HTTPS credential, OAuth token or SSH key material to the server, and SHALL NOT enable SSH agent forwarding itself. Agent forwarding SHALL happen only when the user's own SSH configuration enables it.

#### Scenario: Bound GitHub account

- **WHEN** a GitHub account is bound in GitLane and the user pushes from a remote repository
- **THEN** that account's token is not sent to the server, and the push authenticates with the server's own credentials

### Requirement: Host suggestions come from the user's SSH config

When opening a remote repository, GitLane SHALL suggest the non-wildcard `Host` entries from the user's SSH config. It SHALL also accept any host the user types.

#### Scenario: Wildcard entries skipped

- **WHEN** the SSH config contains `Host devbox`, `Host build-*` and `Host *`
- **THEN** only `devbox` is suggested, and typing `build-7` is still accepted
