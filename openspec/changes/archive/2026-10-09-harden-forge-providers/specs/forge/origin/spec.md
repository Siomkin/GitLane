# Spec Delta

## ADDED Requirements

### Requirement: An expired Origin session is reported as an authentication error

When the `origin` CLI fails because the user is signed out or the session is expired, the
error SHALL have kind `auth` and tell the user how to sign in again, like the GitLab and
Bitbucket providers.

#### Scenario: Signed-out Origin session lists pull requests
- **WHEN** `origin pr list` fails because no session is signed in
- **THEN** the PR list shows an authentication error with the "Fix authentication" action and a hint to run `origin auth login`

### Requirement: The Origin account probe is time-bounded

The Settings account probe for Origin SHALL finish within the same timeout as the other
providers' probes, and SHALL not spawn `origin` on platforms where Origin is unsupported.

#### Scenario: Offline network
- **WHEN** `origin auth status` does not return
- **THEN** the Accounts row falls back to the provider-level label after the probe timeout instead of loading forever

### Requirement: An unrecognised Origin pull-request state passes through

An Origin pull request whose state GitLane does not recognise SHALL keep that raw state
rather than being shown as open.

#### Scenario: New server state
- **WHEN** Origin returns a pull request with state `queued`
- **THEN** it is not listed under Open and no Merge or Close action is offered for it
