## Purpose

GitLane performs GitHub pull-request operations with the token of the account the repository is bound to. This capability fixes what GitLane guarantees about where that token goes: only to the repository and host GitLane validated for the account.

## Requirements

### Requirement: A bound account's token reaches only the validated repository

Every GitHub operation GitLane performs with a bound account's token MUST name the repository and host GitLane validated for that account. The target MUST NOT be inferred by the tool from repository-controlled configuration (remote URLs, `remote.*.gh-resolved`) after the token has been supplied. This holds for extension-backed operations (stack linking) as much as for core pull-request commands.

#### Scenario: Stack link in a repository with a second forge remote

- **WHEN** the repository's configuration names `origin` on `github.com` and an `upstream` remote on another host marked as the resolved base, and the user links a stack of pull requests just created on `github.com`
- **THEN** the link is applied to the `github.com` repository GitLane validated
- **AND** the bound account's token is presented to no other host

#### Scenario: Stack link with an ambient repository override

- **WHEN** GitLane was launched from a shell that exports `GH_REPO` or `GH_HOST` naming a different repository or host, and the user links a stack
- **THEN** the link is applied to the repository GitLane validated and the exported value is ignored

#### Scenario: Stack link when the extension is absent

- **WHEN** the user links a stack and the `gh stack` extension is not installed
- **THEN** GitLane reports that the pull request was created but linking needs the extension, naming the install command, and no token is presented anywhere else

#### Scenario: Enterprise host

- **WHEN** the repository is bound to an account on a GitHub Enterprise Server host and the user links a stack
- **THEN** the operation targets that host's validated repository and the token is scoped to that host
