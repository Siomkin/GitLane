## MODIFIED Requirements

### Requirement: Features unavailable on remote repositories are disabled up front

For a remote repository, GitLane SHALL disable or hide file editing in the file workspace, reveal-in-file-manager, open-in-local-editor and AI agent sessions, including the actions that start a terminal agent or hand text to one, and SHALL say they are unavailable for remote repositories. Viewing files read-only, the integrated terminal and pull requests (where the next requirement allows them) SHALL remain available. Any summary of what is off for a remote repository, such as the SSH chip's tooltip, SHALL list exactly the features disabled here and SHALL NOT name a feature that is available.

#### Scenario: Terminal on a remote tab

- **WHEN** the active tab is a remote repository
- **THEN** the terminal action is enabled, the terminal shows no agent launch buttons, and Commit with agent and handing review comments to an agent are disabled with a tooltip saying they are unavailable for remote repositories

#### Scenario: Viewing a file

- **WHEN** the user opens a file in a remote repository's file workspace
- **THEN** its source is shown read-only, with no edit or save actions

#### Scenario: SSH chip tooltip

- **WHEN** the user hovers the SSH chip of a connected remote repository
- **THEN** the tooltip says Git runs on the server with the server's credentials and config, names file editing, OS openers and agents as unavailable, and does not say the terminal or pull requests are off

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

## ADDED Requirements

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
