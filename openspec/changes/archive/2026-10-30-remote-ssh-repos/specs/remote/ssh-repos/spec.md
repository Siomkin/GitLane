# Spec Delta

## Purpose

Lets a user open and work on a git repository that lives on another machine, reached over SSH, with the repository's code and history staying on that machine.

## ADDED Requirements

### Requirement: A remote repository is addressed by an ssh locator

GitLane SHALL open a repository given as `ssh://[user@]host[:port]/<absolute path>`, where `host` is any name the user's `ssh` accepts, including a config alias. The locator SHALL identify the repository everywhere a local path does: tabs, recent repositories and per-repository settings. A path that is relative or starts with `~`, and a host or user that `ssh` could read as an option, SHALL be rejected before connecting.

#### Scenario: Open by config alias

- **WHEN** the user opens `ssh://devbox/srv/app` and `devbox` is a `Host` in their SSH config
- **THEN** GitLane connects using that config entry and opens the repository at `/srv/app` on that machine

#### Scenario: Remote repository is remembered

- **WHEN** the user opens a remote repository, quits, and relaunches GitLane
- **THEN** the repository appears in recent repositories under its locator and reopens on the same host and path

#### Scenario: Relative path rejected

- **WHEN** the user enters the path `~/app` or `app` for host `devbox`, or the locator `ssh://devbox/~/app`
- **THEN** GitLane rejects it with a message asking for an absolute path, and makes no connection

#### Scenario: Host that looks like an option

- **WHEN** the locator's host is `-oProxyCommand=…`
- **THEN** GitLane rejects it before running `ssh`

### Requirement: Remote repository content stays on the server

GitLane SHALL NOT copy a remote repository's objects, history or working-tree files to the local disk. Only the results needed for what the user is viewing SHALL be transferred, and they SHALL be held in memory only.

#### Scenario: Browsing history leaves no local copy

- **WHEN** the user browses the history, diffs and files of a remote repository and closes its tab
- **THEN** no repository objects, packfiles or working-tree files from that repository exist on the local disk

### Requirement: The connection uses the user's own SSH setup and asks in the app

GitLane SHALL connect with the user's installed `ssh` client and its configuration, keys and running agent. When `ssh` asks for a password, passphrase or one-time code, GitLane SHALL show ssh's prompt in an in-app dialog and pass the answer only to that connect attempt's `ssh` processes, asking once per attempt. The answer SHALL NOT be stored, logged or sent elsewhere, and SHALL be forgotten when the attempt ends. Cancelling SHALL fail the connection.

#### Scenario: One password for the whole connect

- **WHEN** a password-only server needs the agent installed, so the connect runs several `ssh` processes
- **THEN** the user is asked for the password once

#### Scenario: Key in the running agent

- **WHEN** the user's ssh-agent holds a key the server accepts
- **THEN** the repository opens without any prompt

#### Scenario: Server wants a password

- **WHEN** the server accepts only password authentication
- **THEN** GitLane shows a password dialog naming the host, and the repository opens once the correct password is entered

#### Scenario: Prompt during launch restore

- **WHEN** GitLane relaunches with a remote tab active and its host asks for a password
- **THEN** the password dialog is shown over the restoring workspace, and cancelling it leaves the tab in the disconnected state

### Requirement: Host trust is decided by the user, never overridden

On the first connection to a host whose key is not in the user's known hosts, GitLane SHALL show the key's fingerprint and ask whether to trust it. Trusting SHALL let `ssh` record the key in the user's own known-hosts file, exactly as answering `yes` in a terminal would. GitLane SHALL NOT disable host-key checking, and SHALL NOT offer to replace a recorded key that does not match.

#### Scenario: First connection to an unknown host

- **WHEN** the user opens a repository on a host absent from their known hosts
- **THEN** GitLane shows the host name and key fingerprint, and on trust the key is added to the user's known-hosts file and the connection continues

#### Scenario: Unknown host declined

- **WHEN** the user declines the fingerprint
- **THEN** the connection fails and the known-hosts file is unchanged

#### Scenario: Changed host key

- **WHEN** the host key on record does not match the server's key
- **THEN** opening fails with an error naming the host, and GitLane does not offer to replace the recorded key

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

### Requirement: GitHub remotes use the server's own gh login

When `gh` on the server is logged in for a GitHub HTTPS remote's host, fetch, pull and push in a remote repository SHALL authenticate with that `gh` account, with no command run by the user and the token staying on the server. Without any usable credentials there, the error SHALL name the server and the remote host and SHALL NOT suggest this computer's accounts.

#### Scenario: gh logged in on the server

- **WHEN** `gh` on the server is logged in to github.com and the repository's `origin` is `https://github.com/…`
- **THEN** fetch, pull and push succeed with no prompt and no configuration change on the server

#### Scenario: No credentials on the server

- **WHEN** neither `gh` nor a non-interactive credential helper on the server can authenticate the remote
- **THEN** the failure names the server and the remote host, and offers no action that changes this computer's accounts

### Requirement: The hosting provider is shown for a remote repository

A remote repository SHALL show which provider its remote is hosted on, with a link to the repository there, read from the server's remote configuration. Its pull-request views SHALL stay disabled.

#### Scenario: GitHub origin

- **WHEN** a remote repository's `origin` is a GitHub URL
- **THEN** the toolbar shows GitHub with a link to the repository, and no pull requests are loaded

### Requirement: SSH connections can be saved and named

The user SHALL be able to save, edit and remove a named SSH connection (host, optional user, port and private-key file) from the open dialog and from Settings. Each SHALL identify one `ssh://[user@]host[:port]` origin, and a second one for the same origin SHALL be refused. Every connect to that origin, including launch and reconnect, SHALL use its key file ahead of any agent key, and the tab's tooltip and the toolbar SHALL show its name.

#### Scenario: Key file used for every connect

- **WHEN** the user saves "Work laptop" for `me@build.example` with the key `~/.ssh/work_ed25519`, opens a repository there, and later reconnects after a drop
- **THEN** each connect authenticates with that key, and the toolbar and the tab's tooltip show "Work laptop"

#### Scenario: Duplicate origin

- **WHEN** the user saves a second connection for `me@build.example` on the same port
- **THEN** saving is refused with a message naming the existing connection

### Requirement: A connection can be tested before it is saved

The connection form SHALL offer a test that connects with the form's values, installing the helper and asking any sign-in questions, without saving the connection or opening a repository. The connection the test opened SHALL be closed afterwards unless a repository on that origin is open.

#### Scenario: Test then cancel

- **WHEN** the user tests an unsaved connection successfully and then cancels the form
- **THEN** nothing is saved, and no SSH session to that host is left running

### Requirement: Opening a remote repository needs no ssh syntax

The open dialog SHALL offer the saved connections, the non-wildcard `Host` entries from the user's SSH config, and adding a new connection. After connecting, it SHALL let the user browse folders on the server, starting at the user's home directory, with git repositories marked. Choosing a repository SHALL open it. Typing an absolute path SHALL still work. Closing the dialog without opening a repository SHALL close the session it opened unless a repository on that origin is open.

#### Scenario: Wildcard entries skipped

- **WHEN** the SSH config contains `Host devbox`, `Host build-*` and `Host *`
- **THEN** only `devbox` is offered from the SSH config

#### Scenario: Browse to a repository

- **WHEN** the user connects to `devbox` and opens `projects`, which contains the git repository `app`
- **THEN** `app` is marked as a repository, and choosing it opens `ssh://devbox/home/<user>/projects/app`

#### Scenario: Unreadable folder

- **WHEN** a folder in the browser cannot be read on the server
- **THEN** that folder shows as unreadable and the rest of the listing still appears
