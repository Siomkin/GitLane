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
