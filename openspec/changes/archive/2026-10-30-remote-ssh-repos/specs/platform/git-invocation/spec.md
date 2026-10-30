# Spec Delta

## ADDED Requirements

### Requirement: Network operations over SSH use the server's own credentials

For a repository opened over SSH, a fetch, pull, or push MUST run on the server with the server's own git configuration and credentials, using the server's logged-in `gh` account for a GitHub HTTPS remote. GitLane's bound accounts MUST NOT be applied and no GitLane credential MUST be sent to the server.

#### Scenario: Push from a repository opened over SSH

- **WHEN** the user pushes from `ssh://devbox/srv/app` and a GitHub account is bound in GitLane for that remote URL
- **THEN** the push runs on `devbox` and authenticates with `devbox`'s own `gh` login, credential helper or SSH key
- **AND** the bound account's token is not sent to `devbox`

#### Scenario: Server has no credential for the remote

- **WHEN** the user pulls from a repository opened over SSH and the server has no credential for its remote
- **THEN** the pull fails with an error naming the server and the remote host, shown in the app, and no prompt appears on the server or locally
