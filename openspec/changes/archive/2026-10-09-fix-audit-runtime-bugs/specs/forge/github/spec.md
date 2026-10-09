# Spec Delta

## ADDED Requirements

### Requirement: The create-PR dialog offers the repository's collaborators as reviewers

For a GitHub or GitHub Enterprise repository, GitLane SHALL fetch reviewer candidates from that repository's collaborator list on the repository's own host. A failed lookup MAY show no picker, but a valid repository MUST NOT always yield an empty list.

#### Scenario: Collaborators are listed on github.com
- **WHEN** a user with push access opens the create-PR dialog for `github.com/octo/app`
- **THEN** the reviewer picker lists the collaborators GitHub returns for `octo/app`

#### Scenario: Collaborators are listed on GitHub Enterprise
- **WHEN** a user with push access opens the create-PR dialog for a repository on `ghe.example.test`
- **THEN** the request goes to that host's API for `owner/name` and the picker lists its collaborators
