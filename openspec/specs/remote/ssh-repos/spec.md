# remote/ssh-repos Specification

## Purpose

Lets a user open and work on a git repository that lives on another machine, reached over SSH, with the repository's code and history staying on that machine.

## Requirements

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

GitLane SHALL install an agent binary only after verifying that it is signed with GitLane's release key. The check SHALL run for every installation, including one made from a copy GitLane kept from an earlier download. When verification fails, GitLane SHALL install nothing and opening SHALL fail with an integrity error. A release build SHALL offer no way to install an agent without this check.

#### Scenario: Tampered download

- **WHEN** the agent binary obtained for installation fails signature verification
- **THEN** nothing is uploaded to the server, and opening fails with an integrity error

#### Scenario: Kept copy was changed

- **WHEN** the copy of the agent GitLane kept on this computer no longer matches its signature
- **THEN** GitLane does not upload it, downloads the agent again, and installs it only after verifying the download

#### Scenario: Development override in a release build

- **WHEN** a release build of GitLane starts with the development setting that names a local agent file
- **THEN** the setting is ignored, and only a verified agent is installed

### Requirement: The installed agent is private to the connecting user

The directory GitLane installs its agent into, and everything GitLane puts in it, SHALL be readable, writable and searchable by the connecting user only, whatever the server's default file permissions are. Each connect SHALL bring an existing agent directory with wider permissions back to that state before the agent runs.

#### Scenario: Server with group-writable defaults

- **WHEN** GitLane installs the agent on a server whose default permissions make new directories group-writable
- **THEN** the agent directory and its version directories grant no access to the group or to others

#### Scenario: Install made by an earlier version

- **WHEN** the user connects to a server whose agent directory was created group-writable by an earlier GitLane version
- **THEN** the agent directory grants no access to the group or to others before the agent starts

### Requirement: Only an agent owned by the connecting user is run

GitLane SHALL run an agent on the server only when the agent file and the directories GitLane keeps it in are owned by the connecting user. It SHALL NOT write into an agent directory owned by another account. Where the server does not report even the user's home directory as theirs, ownership cannot be judged and this check SHALL NOT block the connect.

#### Scenario: Home directory on a mount that maps owners

- **WHEN** the server reports the connecting user's own home directory as owned by another account
- **THEN** GitLane installs and runs the agent as it does elsewhere, protected by the owner-only permissions alone

#### Scenario: Agent file placed by another account

- **WHEN** the agent file for the app's version exists on the server but is owned by another account
- **THEN** GitLane does not run it, and installs its own verified agent in its place before opening the repository

#### Scenario: Agent directory owned by another account

- **WHEN** the agent directory for the app's version is owned by another account
- **THEN** GitLane runs nothing from it and writes nothing into it, and opening fails with an error that names the directory and says to remove it on the server

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

For a remote repository, GitLane SHALL disable or hide file editing in the file workspace, reveal-in-file-manager, open-in-local-editor and AI agent sessions, including the actions that start a terminal agent or hand text to one, and SHALL say they are unavailable for remote repositories. Viewing files read-only, the integrated terminal and pull requests (where the next requirement allows them) SHALL remain available. A summary of what is off SHALL name only these features.

#### Scenario: Terminal on a remote tab

- **WHEN** the active tab is a remote repository
- **THEN** the terminal action is enabled, the terminal shows no agent launch buttons, and Commit with agent and handing review comments to an agent are disabled with a tooltip saying they are unavailable for remote repositories

#### Scenario: Viewing a file

- **WHEN** the user opens a file in a remote repository's file workspace
- **THEN** its source is shown read-only, with no edit or save actions

#### Scenario: SSH chip tooltip

- **WHEN** the user hovers the SSH chip of a connected remote repository
- **THEN** the tooltip says Git runs on the server with the server's credentials and config, names file editing, OS openers and agents as unavailable, and does not say the terminal or pull requests are off

### Requirement: Remote repositories update live

Changes made on the server outside GitLane SHALL appear in the open remote repository without user action, on the same schedule as local repositories. When the server cannot watch the repository, GitLane SHALL show a non-blocking notice once and SHALL refresh when the window regains focus.

#### Scenario: Commit made in a server shell

- **WHEN** someone commits in the repository from a shell on the server while its tab is open
- **THEN** the new commit appears in the graph without the user refreshing

#### Scenario: Watch limit reached

- **WHEN** the server refuses to watch the repository because of a system watch limit
- **THEN** GitLane shows a single non-blocking notice, and the tab refreshes each time the window regains focus

### Requirement: A server's change notices apply only to that server

GitLane SHALL treat a change notice from a server as naming a repository on that server and no other host. A notice whose path is not an absolute path on the server SHALL be ignored.

#### Scenario: Notice with a path that is not absolute

- **WHEN** a server's agent reports a change for a path that does not start with `/`
- **THEN** no open repository is refreshed, on that server or any other

#### Scenario: Notice for an open repository

- **WHEN** a server's agent reports a change for the absolute path of a repository open from that server
- **THEN** that repository's tab refreshes

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

When `gh` on the server is logged in for a GitHub HTTPS remote's host, fetch, pull and push in a remote repository SHALL authenticate with that `gh` account, with no command run by the user and the token staying on the server. Without any usable credentials there, the error SHALL name the server and the remote host, SHALL say how to fix it on the server (log in the forge CLI there, set up a credential helper there, or use an SSH remote URL), and SHALL NOT suggest this computer's accounts.

#### Scenario: gh logged in on the server

- **WHEN** `gh` on the server is logged in to github.com and the repository's `origin` is `https://github.com/…`
- **THEN** fetch, pull and push succeed with no prompt and no configuration change on the server

#### Scenario: No credentials on the server

- **WHEN** neither `gh` nor a non-interactive credential helper on the server can authenticate the remote
- **THEN** the failure names the server and the remote host, includes the command to run on the server (for a GitHub host, `gh auth login --hostname <host>`), mentions a credential helper or an SSH remote URL as alternatives, and offers no action that changes this computer's accounts

### Requirement: The hosting provider is shown for a remote repository

A remote repository SHALL show which provider its remote is hosted on, with a link to the repository there, read from the server's remote configuration. Its pull-request views SHALL follow the requirement "Pull requests on a remote repository use the server's forge login".

#### Scenario: GitHub origin

- **WHEN** a remote repository's `origin` is a GitHub URL
- **THEN** the toolbar shows GitHub with a link to the repository

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

### Requirement: An open ssh question pauses the connect timeout only while it is open

While an ssh question for a connect attempt is shown to the user, the time it stays open MUST NOT count toward that attempt's connect timeout. Once the question closes, the timeout MUST resume, so a connect that then stalls still fails. This holds however the question closes: answered, cancelled, expired, or failed inside GitLane.

#### Scenario: Slow answer
- **GIVEN** a connect attempt whose host asks for a password
- **WHEN** the user takes longer than the connect timeout to answer, and the host then responds
- **THEN** the connect succeeds and is not timed out

#### Scenario: Question fails inside GitLane
- **GIVEN** a connect attempt whose host asks a question
- **WHEN** GitLane fails to show or collect the answer, and the host never completes the connect
- **THEN** the connect still fails after the timeout, and the tab shows the connection error

### Requirement: Pull requests on a remote repository use the server's forge login

For a GitHub or GitLab remote, a remote repository SHALL offer the same pull-request views and actions as a local one, run on the server through the server's own `gh` or `glab` login. No account, token or account reference from this computer SHALL reach the server, and a write SHALL show beforehand which server login it runs as. For Bitbucket or Cursor Origin, pull-request views SHALL stay disabled with a reason naming the provider.

#### Scenario: GitHub PRs through the server's gh

- **WHEN** a remote repository's `origin` is on github.com and `gh` on the server is logged in there as `octocat`
- **THEN** the PRs tab is enabled, lists the repository's pull requests, and opening one shows its detail, diff, checks and threads

#### Scenario: Merge acts as the server login

- **WHEN** the user merges a pull request in a remote repository
- **THEN** the merge runs on the server as the server's `gh` login, which the merge action shows beforehand, and no GitLane account bound on this computer is used

#### Scenario: Bound desktop account is not forwarded

- **WHEN** a GitHub account is bound to the repository on this computer and the user lists pull requests in a remote repository
- **THEN** the request reaching the server carries no account reference and no token

#### Scenario: Bitbucket remote

- **WHEN** a remote repository's `origin` is on Bitbucket
- **THEN** the PRs tab is disabled with a tooltip saying Bitbucket pull requests are unavailable for remote repositories

### Requirement: The server's forge login is shown with how to fix it

For a GitHub or GitLab remote, GitLane SHALL show whether the server's `gh` or `glab` is usable and logged in for the remote's host, and as whom. When it is not, the SSH chip and the PR panel SHALL show the command to run on the server and offer to open the remote terminal. GitLane SHALL NOT run the sign-in or ask for a secret, and a retry SHALL pick up a new login without reconnecting.

#### Scenario: gh not logged in on the server

- **WHEN** a remote repository's `origin` is on github.com and `gh` on the server is installed but not logged in there
- **THEN** the PR panel says the server is not signed in to GitHub, shows `gh auth login --hostname github.com`, and offers Open terminal, which opens the remote tab's terminal on the server

#### Scenario: gh missing on the server

- **WHEN** `gh` is not installed on the server, or is older than GitLane's minimum version
- **THEN** the PR panel names the server and says `gh` must be installed or upgraded there, with the minimum version

#### Scenario: Logged in after the hint

- **WHEN** the user runs `gh auth login` in the remote terminal and then retries in the PR panel
- **THEN** the pull requests load and the SSH chip shows the server's login, without reconnecting
