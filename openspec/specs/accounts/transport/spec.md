## Purpose

GitLane can hold a provider credential for a host on the user's behalf — captured by native sign-in or pasted as a token — and hand it to git and forge operations without it ever leaving the backend. This capability fixes what capturing and storing that credential guarantees.

## Requirements

### Requirement: A native browser sign-in completes despite unrelated local requests

While a browser-redirect sign-in is waiting for the provider's callback, a request to the local callback listener that does not carry the sign-in's one-time state value MUST NOT end, fail, or otherwise change the outcome of the sign-in. Only a callback carrying the matching state MUST be accepted as the provider's answer, whether it reports success or a provider error. The sign-in still ends on the user's cancel or on its deadline.

#### Scenario: Stray error request before the real callback

- **WHEN** a Bitbucket sign-in is waiting and a local client sends a callback request with `error=denied` and no state, and the browser then delivers the real callback with the authorization code and matching state
- **THEN** the sign-in continues, accepts the real callback, and completes

#### Scenario: Provider denial with matching state

- **WHEN** the user declines authorization in the browser and the provider redirects with `error=access_denied` and the matching state
- **THEN** the sign-in ends with an authorization-failed message

#### Scenario: Forged code with wrong state

- **WHEN** a local client sends a callback carrying a code and a state value that does not match
- **THEN** the code is discarded, no token exchange is attempted, and the sign-in keeps waiting

#### Scenario: Deadline still applies

- **WHEN** no callback with the matching state arrives before the sign-in deadline
- **THEN** the sign-in ends with a timeout message

### Requirement: A stored credential is never replaced or orphaned by a different account card

A credential GitLane stores for one account card on a host MUST remain retrievable and deletable through that card until the user signs that card out. Completing a sign-in for another card on the same host — including a native sign-in whose provider-reported identifier happens to equal another card's typed login — MUST NOT replace, delete, or orphan the first card's credential.

#### Scenario: Pasted token and native sign-in with colliding identifiers

- **WHEN** the user has saved a pasted token for a GitLab host under login `42`, and then completes native sign-in on that host as an account whose provider id is `42`
- **THEN** both cards remain, fetch/push with the pasted-token card still authenticates with the pasted token, and signing out the pasted-token card leaves the native sign-in usable

#### Scenario: Re-sign-in of the same native account

- **WHEN** the user completes native sign-in on a host for an account already signed in natively
- **THEN** that account's stored credential is replaced with the new one and no other card is affected

#### Scenario: Pasted login that imitates a native locator

- **WHEN** the user pastes a token and types a login that uses GitLane's reserved native-sign-in namespace
- **THEN** GitLane refuses to save it with a message asking for the account username

### Requirement: The provider-token credential broker answers every well-formed request

When git asks GitLane's askpass helper for a stored provider token, the broker SHALL answer
every well-formed request, on every supported platform and whatever the timing of the
helper's writes.

#### Scenario: Helper writes its request after the broker accepted the connection
- **WHEN** on macOS the askpass child connects and its request bytes arrive a few milliseconds after the broker's first read
- **THEN** the broker waits within its read deadline and returns the token, and the git operation authenticates

#### Scenario: A slow helper past the deadline
- **WHEN** the request is not complete within the connection deadline
- **THEN** the broker closes the connection without answering, as today

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
