## Purpose

GitLane drives the user's real `git` binary, which reads configuration and environment from the
machine it runs on. This capability fixes what GitLane guarantees about that subprocess, so the
result of an operation depends on the repository and the user's request, never on how the user
happens to have configured or localized their git.

## Requirements

### Requirement: Git diagnostics reach GitLane in a stable language

Every git subprocess GitLane runs MUST produce its messages in a fixed language, so that error
classification and outcome detection cannot change with the user's locale. GitLane MUST NOT depend on
individual call sites opting into stable diagnostics.

#### Scenario: A conflict is reported on a localized system

- **WHEN** the user's session language is not English and a rebase, cherry-pick, or revert stops on a
  conflict
- **THEN** GitLane classifies the failure as a conflict and opens the conflict workspace
- **AND** the classification is identical to the one produced on an English system

#### Scenario: A stash succeeds on a localized system

- **WHEN** the user's session language is not English and a per-file stash succeeds
- **THEN** GitLane treats the stash as routine and does not surface git's raw output as a message

#### Scenario: A push is rejected on a localized system

- **WHEN** the user's session language is not English and a push is rejected as non-fast-forward
- **THEN** GitLane recognises the rejection and offers the same follow-up it offers in English

### Requirement: The commit identity GitLane pins is the identity that is used

When GitLane pins an author or committer identity for an operation, that identity MUST be the one
recorded in the resulting commit. An identity present in the environment GitLane was launched with
MUST NOT override it.

#### Scenario: The launching environment carries an author email

- **WHEN** GitLane is launched from a shell that exports an author or committer name, email, or date,
  and the user commits with an identity card applied
- **THEN** the commit's author and committer are the identity card's name and email
- **AND** no field is taken from the launching environment

#### Scenario: An operation deliberately replays an original author

- **WHEN** GitLane replays existing commits and pins each one's original author explicitly
- **THEN** each replayed commit keeps its original author name, email, and date

### Requirement: Machine-read git output carries no configuration-dependent decoration

Output that GitLane parses MUST contain only the records it asked for. Configuration that makes git
decorate, annotate, or verify its output MUST NOT change what GitLane reads.

#### Scenario: The user has signature display enabled

- **WHEN** the user's configuration displays signatures for every log command and the repository's
  commits are signed
- **THEN** recovery entries, operation previews, and commit replays read the intended records only
- **AND** no verification text appears as an entry, a listed commit, or a field value

#### Scenario: Repository-routing variables are present in the environment

- **WHEN** the environment GitLane inherits points git at a different repository, index, or object
  store
- **THEN** the operation acts on the repository the user opened

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

### Requirement: The login-shell PATH comes only from the probe's own output, within a timeout

GitLane SHALL take the login shell's PATH only from text its probe prints, ignoring
anything the user's shell startup files print. The probe SHALL be abandoned after a bounded
time, and GitLane then falls back to the inherited PATH.

#### Scenario: Shell startup file prints a greeting
- **WHEN** the user's `.zshrc` prints "Welcome back" and PATH is `/opt/homebrew/bin:/usr/bin`
- **THEN** GitLane's PATH starts with `/opt/homebrew/bin`, and `gh` and Homebrew `git` are found

#### Scenario: Shell startup file hangs
- **WHEN** the login shell does not exit
- **THEN** git, gh and agent launches proceed with the fallback PATH after the timeout instead of blocking

### Requirement: Credential-helper git runs are insulated like every other git run

The git subprocesses GitLane starts to save, check or forget an HTTPS credential SHALL run
without inherited provider-token environment variables and under the pinned message
locale, like every other git subprocess.

#### Scenario: GitLane launched from a shell that exports a provider token
- **WHEN** `GH_TOKEN` is set in GitLane's environment and the user saves an HTTPS credential for a host whose helper is `!gh auth git-credential`
- **THEN** the post-save `git credential fill` check does not see `GH_TOKEN`, and succeeds only with the credential just saved
