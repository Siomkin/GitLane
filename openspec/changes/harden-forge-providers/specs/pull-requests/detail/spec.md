# Spec Delta

## ADDED Requirements

### Requirement: A provider-capped diff says it is truncated

When a provider's diff read stops at GitLane's page cap, the returned files SHALL be marked
truncated, so the Diff tab and the detail file counts never present a partial diff as
complete.

#### Scenario: GitLab merge request with more files than the cap
- **WHEN** a GitLab MR's diff fills every allowed page
- **THEN** the files carry the truncated flag, as a Bitbucket pull request in the same situation does

### Requirement: Provider web links keep the remote's scheme and port

Links GitLane builds to a repository's pages on its forge SHALL use the scheme and port of
the repository's HTTP(S) remote.

#### Scenario: Self-hosted GitLab on a custom port
- **WHEN** the remote is `https://gitlab.example.com:8443/team/app.git`
- **THEN** the "merge requests" link opens `https://gitlab.example.com:8443/team/app/-/merge_requests`

#### Scenario: SSH remote
- **WHEN** the remote is `git@gitlab.example.com:team/app.git`
- **THEN** links use `https://gitlab.example.com/team/app`
