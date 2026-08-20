## MODIFIED Requirements

### Requirement: Origin repositories expose the read-first pull-request surface

For a Cursor Origin repository, GitLane SHALL enable pull-request list, detail, refresh, commit, diff, discussion display, existing-thread flows, create, lifecycle-state changes, and merge instead of showing an unsupported-forge state. Deferred Origin write actions MUST be omitted or fail with an Origin-specific unsupported message and MUST NOT invoke GitHub.

#### Scenario: PRs tab is available
- **WHEN** the user opens a Cursor Origin repository
- **THEN** GitLane enables the PRs tab and loads it through Origin

#### Scenario: Create an open pull request
- **WHEN** the user submits the existing create-PR dialog for an Origin branch with draft mode disabled
- **THEN** Origin creates an open pull request with the selected head, base, title, and description, and GitLane refreshes the pull-request list

#### Scenario: Create a draft pull request
- **WHEN** the user submits the existing create-PR dialog for an Origin branch with draft mode enabled
- **THEN** Origin creates a draft pull request with the selected head, base, title, and description, and GitLane refreshes the pull-request list

#### Scenario: Close and reopen a pull request
- **WHEN** the user confirms Close for an open Origin pull request or Reopen for a closed Origin pull request
- **THEN** Origin records the requested lifecycle state and GitLane refreshes the pull-request list and detail

#### Scenario: Mark a draft ready
- **WHEN** the user confirms Ready for a draft Origin pull request
- **THEN** Origin marks the pull request ready for review and GitLane refreshes its state

#### Scenario: Deferred write is unavailable
- **WHEN** the user would edit, review, start a new top-level comment, or start a new inline thread on an Origin pull request
- **THEN** GitLane omits the action or returns an Origin-specific unsupported message without invoking `gh`

#### Scenario: Merge a pull request
- **WHEN** the user merges an open Origin pull request with squash or a merge commit
- **THEN** GitLane runs `origin pr merge` with `--squash` or `--merge` and does not offer rebase-and-merge or delete-branch

#### Scenario: Known unsupported forges still refuse
- **WHEN** the user opens an Azure DevOps, Gitea, or Forgejo repository
- **THEN** GitLane does not offer Origin or GitHub pull-request loading

## ADDED Requirements

### Requirement: Origin pull requests open externally with visible failure feedback

GitLane SHALL open a selected Origin pull request in the user's system browser through the shared validated external-URL path. If the URL is unavailable, invalid, or the system opener fails, GitLane MUST show an actionable error instead of silently ignoring the click.

#### Scenario: Open an Origin pull request in the browser
- **WHEN** the user activates the external-link control for an Origin pull request with a valid HTTP or HTTPS URL
- **THEN** GitLane asks the operating system to open that URL in the default browser

#### Scenario: External opener fails
- **WHEN** the operating system rejects the request to open an Origin pull-request URL
- **THEN** GitLane shows an error that explains the pull request could not be opened externally

#### Scenario: Origin pull-request URL is unusable
- **WHEN** the selected Origin pull request has no URL or has a URL with a disallowed scheme
- **THEN** GitLane refuses to pass it to the operating system and shows an error
