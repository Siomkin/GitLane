## Purpose

Lets GitLane recognise Cursor Origin remotes and inspect their pull requests and existing review threads through the user's Origin CLI session without storing Origin credentials.

## ADDED Requirements

### Requirement: Origin remotes are classified as Cursor Origin

GitLane MUST classify a repository whose default remote host is `origin.cursor.com` as Cursor Origin. It MUST NOT treat that host as GitHub or as an unrecognised forge.

#### Scenario: HTTPS Origin remote
- **WHEN** the open repository's remote URL is `https://origin.cursor.com/acme/app.git`
- **THEN** GitLane reports the forge as Cursor Origin

#### Scenario: SSH Origin remote
- **WHEN** the open repository's remote URL is `git@origin.cursor.com:acme/app.git`
- **THEN** GitLane reports the forge as Cursor Origin

#### Scenario: GitHub remotes stay GitHub
- **WHEN** the open repository's remote URL is `https://github.com/acme/app.git`
- **THEN** GitLane reports the forge as GitHub and does not select Origin

### Requirement: Origin repositories expose the read-first pull-request surface

For a Cursor Origin repository, GitLane SHALL enable pull-request list, detail, refresh, commit, diff, discussion display, and existing-thread flows instead of showing an unsupported-forge state. Deferred Origin write actions MUST be omitted or fail with an Origin-specific unsupported message and MUST NOT invoke GitHub.

#### Scenario: PRs tab is available
- **WHEN** the user opens a Cursor Origin repository
- **THEN** GitLane enables the PRs tab and loads it through Origin

#### Scenario: Deferred write is unavailable
- **WHEN** the user would create, edit, merge, change state, review, or start a new comment on an Origin pull request
- **THEN** GitLane omits the action or returns an Origin-specific unsupported message without invoking `gh`

#### Scenario: Known unsupported forges still refuse
- **WHEN** the user opens an Azure DevOps, Gitea, or Forgejo repository
- **THEN** GitLane does not offer Origin or GitHub pull-request loading

### Requirement: Users can list and inspect Origin pull requests

GitLane SHALL list Origin pull requests and show detail, discussion comments, commits, and changed-file diff for a selected pull request. Pull-request numbers MUST use Origin's repository-local numbers.

#### Scenario: List pull requests
- **WHEN** the PRs tab opens on an Origin repository and the Origin CLI is signed in
- **THEN** GitLane shows that repository's Origin pull requests with title, number, and state

#### Scenario: View detail and discussion
- **WHEN** the user selects an Origin pull request
- **THEN** GitLane shows its title, body, branches, files, and available discussion comments without requiring a GitHub account

#### Scenario: View commits and diff
- **WHEN** the user opens the commits or changes view for an Origin pull request
- **THEN** GitLane shows its commits and parsed file diff

### Requirement: Users can work with existing Origin review threads

GitLane SHALL list existing Origin review threads and SHALL allow users to reply, resolve, and reopen those threads. GitLane MUST NOT claim to start a new line-anchored thread in this slice.

#### Scenario: List threads
- **WHEN** the selected Origin pull request has review threads
- **THEN** GitLane shows those threads with their resolution state

#### Scenario: Reply to a thread
- **WHEN** the user replies to an existing Origin review thread
- **THEN** Origin stores the reply and GitLane refreshes the thread

#### Scenario: Resolve and reopen a thread
- **WHEN** the user resolves or reopens an existing Origin review thread
- **THEN** Origin records the new resolution state and GitLane reflects it

#### Scenario: New inline thread is unavailable
- **WHEN** the user would start a new diff-anchored thread on Origin
- **THEN** GitLane omits or explicitly refuses that action without invoking GitHub

### Requirement: Origin authentication stays in the Origin CLI

GitLane SHALL use the user's Origin CLI session. It MUST NOT extract, persist, reinject, log, or return Origin API keys or auth tokens. Forge-auth status SHALL report whether the CLI is signed in and SHALL show the non-secret Origin login when available.

#### Scenario: Signed-in Origin CLI
- **WHEN** `origin` is installed and signed in
- **THEN** Origin PR operations use that session and the account UI shows the Origin login without a token

#### Scenario: Not signed in
- **WHEN** `origin` is installed without a session
- **THEN** GitLane instructs the user to run `origin auth login` and does not request an Origin token through GitLane

#### Scenario: Failed command does not expose secrets
- **WHEN** an Origin command fails
- **THEN** the displayed error contains no Origin bearer token, API key, or `CURSOR_AUTH_TOKEN` value

### Requirement: Missing or unusable Origin CLI fails clearly

GitLane MUST refuse Origin PR operations with an actionable Origin-specific message when the CLI is missing, lacks required capabilities, or is unsupported on the current OS. It MUST NOT fall back to `gh`.

#### Scenario: CLI not installed
- **WHEN** an Origin PR operation runs and `origin` is not on the resolved PATH
- **THEN** GitLane explains that the Origin CLI is required and does not invoke `gh`

#### Scenario: Native Windows
- **WHEN** an Origin PR operation is attempted on native Windows
- **THEN** GitLane reports that the Origin CLI is unavailable or unsupported instead of showing a GitHub error

### Requirement: Origin git transport does not use GitHub credentials

Fetch, pull, and push for an Origin remote MUST use the system git credential helper or SSH keys. GitLane MUST NOT inject GitHub CLI credentials for `origin.cursor.com`.

#### Scenario: HTTPS fetch
- **WHEN** the user fetches an `origin.cursor.com` HTTPS remote
- **THEN** GitLane does not pass a GitHub token or `gh auth git-credential`

#### Scenario: History works without PR access
- **WHEN** git credentials already work and the user never opens the PRs tab
- **THEN** graph, staging, commit, fetch, and push continue through the existing git paths
