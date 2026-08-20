## MODIFIED Requirements

### Requirement: Origin repositories expose the read-first pull-request surface

For a Cursor Origin repository, GitLane SHALL enable pull-request list, detail, refresh, commit, diff, checks, discussion display, submitted-review display, existing-thread flows, bodyless approvals, create, lifecycle-state changes, and merge instead of showing an unsupported-forge state. Deferred Origin write actions MUST be omitted or fail with an Origin-specific unsupported message and MUST NOT invoke GitHub.

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

#### Scenario: Approve a pull request
- **WHEN** the user confirms approval of an open Origin pull request
- **THEN** Origin records a bodyless approval and GitLane refreshes the pull-request detail

#### Scenario: Deferred write is unavailable
- **WHEN** the user would comment, reply, request changes, file a formal comment-only review, attach text to an approval, edit, or start a new inline thread on an Origin pull request
- **THEN** GitLane omits the action or returns an Origin-specific unsupported message without invoking `gh`

#### Scenario: Merge a pull request
- **WHEN** the user merges an open Origin pull request with squash or a merge commit
- **THEN** GitLane runs `origin pr merge` with `--squash` or `--merge` and does not offer rebase-and-merge or delete-branch

#### Scenario: Known unsupported forges still refuse
- **WHEN** the user opens an Azure DevOps, Gitea, or Forgejo repository
- **THEN** GitLane does not offer Origin or GitHub pull-request loading

### Requirement: Users can list and inspect Origin pull requests

GitLane SHALL list Origin pull requests and show detail, discussion comments, submitted review verdicts, checks, commits, and changed-file diff for a selected pull request. Pull-request numbers MUST use Origin's repository-local numbers.

#### Scenario: List pull requests
- **WHEN** the PRs tab opens on an Origin repository and the Origin CLI is signed in
- **THEN** GitLane shows that repository's Origin pull requests with title, number, and state

#### Scenario: View detail and discussion
- **WHEN** the user selects an Origin pull request
- **THEN** GitLane shows its title, body, branches, files, available discussion comments, and submitted review verdicts without requiring a GitHub account

#### Scenario: View checks
- **WHEN** the user opens the Checks view for an Origin pull request
- **THEN** GitLane shows available Origin checks as passed, failed, pending, or skipped instead of reporting an empty check list for every pull request

#### Scenario: Unrecognized check conclusion
- **WHEN** an Origin check reports a conclusion GitLane does not recognize
- **THEN** GitLane shows that check as pending rather than failed

#### Scenario: View commits and diff
- **WHEN** the user opens the commits or changes view for an Origin pull request
- **THEN** GitLane shows its commits and parsed file diff
