# Spec Delta

## ADDED Requirements

### Requirement: Forge authentication failures name the forge and host that failed

A pull-request operation that fails because the forge rejected or lacked credentials SHALL arrive as `kind: "auth"` for every supported forge. Its message MUST name that forge and the repository's host. It MUST NOT tell the user to sign in to a different forge or host.

#### Scenario: Revoked GitHub Enterprise token
- **WHEN** listing pull requests on `ghe.example.test` fails with HTTP 401
- **THEN** the error is `kind: "auth"` and its message names `ghe.example.test`, not `github.com`

#### Scenario: GitLab CLI not signed in
- **WHEN** a GitLab merge-request operation fails because `glab` is not signed in
- **THEN** the error is `kind: "auth"`, names GitLab and its host, and does not mention `gh auth login`

#### Scenario: Bitbucket REST 401
- **WHEN** a Bitbucket pull-request request returns HTTP 401
- **THEN** the error is `kind: "auth"`, so the toast offers "Fix authentication…"
