## ADDED Requirements

### Requirement: Network operations authenticate as the account bound to the remote

When GitLane runs a fetch, pull, push, or clone and a forge account is bound to the remote, the credential presented to the remote MUST be that account's. A provider token present in the environment GitLane was launched with (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN`, `OAUTH_TOKEN`) MUST NOT be presented by any credential helper GitLane invokes on the user's behalf, and MUST NOT change which account authenticates.

#### Scenario: The launching shell exports a GitHub token for another principal

- **WHEN** GitLane was started from a shell that exports `GH_TOKEN` belonging to account B, and the user pushes to a GitHub remote whose bound account is A
- **THEN** the push authenticates as account A
- **AND** account B's token is not presented to the remote

#### Scenario: The launching shell exports a GitLab token

- **WHEN** GitLane was started with `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN`, or `OAUTH_TOKEN` set, and the user fetches from a GitLab remote whose bound account resolves to the `glab` helper
- **THEN** the fetch authenticates as the bound account and the environment token is not used

#### Scenario: No account is bound

- **WHEN** no account is bound to the remote and the user pushes
- **THEN** GitLane falls through to the user's own configured credential helper, which runs without the launching environment's provider token, and reports a missing credential through the app rather than a terminal prompt

#### Scenario: No account is bound and the user's own helper relied on the environment token

- **WHEN** no account is bound, the user's global credential helper is `gh auth git-credential`, `gh` has no stored account, and GitLane was launched with `GH_TOKEN` set
- **THEN** the push does not authenticate with that token; GitLane reports the missing credential and the Remotes panel's guidance (bind an account) is the fix
