# Spec Delta

## ADDED Requirements

### Requirement: Git transport on a GitHub remote authenticates as the bound gh account

When a GitHub HTTPS remote is bound to a signed-in `gh` account, clone, fetch, pull, and push on that remote MUST authenticate as that account, whichever account `gh` currently has active on the host. GitLane MUST NOT change the user's global `gh` state (for example with `gh auth switch`) to achieve this, and MUST NOT authenticate as a different account when the bound one cannot supply a credential.

#### Scenario: Bound account is not gh's active account

- **WHEN** `gh` is signed in to github.com as `alice` (active) and `bob` (inactive), the repository's `origin` is bound to `bob`, and the user fetches or pushes
- **THEN** the operation authenticates as `bob` and succeeds without a sign-in prompt or auth-error toast

#### Scenario: Bound account is gh's active account

- **WHEN** the remote is bound to the account `gh` has active and the user pulls
- **THEN** the operation authenticates as that account, as before this change

#### Scenario: Global gh state is left alone

- **WHEN** any transport operation above completes, whether it succeeds or fails
- **THEN** `gh auth status` reports the same active account per host as before the operation

#### Scenario: Bound account has no usable token

- **WHEN** the remote is bound to `bob` but `gh` holds no token for `bob` on that host, and `alice` is active
- **THEN** the operation fails with an authentication error and does not authenticate as `alice`

#### Scenario: GitHub Enterprise Server remote

- **WHEN** a GHES remote is bound to an inactive `gh` account on that GHES host and the user pushes
- **THEN** the push authenticates as the bound GHES account

### Requirement: The bound gh account's token never reaches git or its hooks

The token used to authenticate a GitHub transport operation MUST NOT be present in the environment of the git process or of any hook git runs, and MUST NOT cross IPC or be persisted by GitLane.

#### Scenario: Pre-push hook environment

- **WHEN** a repository has a pre-push hook that records its environment and the user pushes to a GitHub remote bound to a `gh` account
- **THEN** the recorded environment contains no `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, or `GITHUB_ENTERPRISE_TOKEN`

### Requirement: A malformed gh account binding is refused before any git command runs

A `gh` account binding whose login is not a plausible GitHub login MUST be rejected with a readable error before git is invoked, and no helper command built from it may run. A plausible login is 1–100 characters of ASCII letters, digits, `-`, `_`, or `.`, and does not start with `-`. This covers github.com, Enterprise Managed User (`name_shortcode`), and GHES logins.

#### Scenario: Enterprise Managed User login

- **WHEN** the remote is bound to the `gh` account `octocat_acme` and the user fetches
- **THEN** the binding is accepted and the fetch authenticates as `octocat_acme`

#### Scenario: Login containing shell metacharacters

- **WHEN** a stored binding's login is `bob'; rm -rf ~; '` and the user fetches
- **THEN** the fetch is refused with an error asking the user to choose the account again, and git is not run
