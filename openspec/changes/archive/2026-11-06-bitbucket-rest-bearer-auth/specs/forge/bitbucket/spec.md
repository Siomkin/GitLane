# Spec Delta

## Purpose

GitLane performs Bitbucket Cloud pull-request operations with a GitLane-owned keychain token. This capability fixes how that token is presented to Bitbucket and how GitLane tells the user that a token is missing or that Bitbucket rejected it.

## ADDED Requirements

### Requirement: Bitbucket pull-request calls present the token as a bearer credential

Every Bitbucket Cloud pull-request operation SHALL present the bound account's GitLane-owned token as a bearer credential, whatever git HTTPS username the account uses. The token SHALL NOT be combined with a username. This holds for an OAuth access token and for a user-saved API token alike.

#### Scenario: API token saved under the Bitbucket username

- **WHEN** the user saved a valid Bitbucket API token (with repository and pull-request scopes) under the git HTTPS username `alice`, and opens the PRs tab of a `bitbucket.org` repository
- **THEN** the pull-request list loads
- **AND** Create PR opens the pull request without an authentication error

#### Scenario: API token saved under the prefilled static username

- **WHEN** the user saved a valid Bitbucket API token under the prefilled git HTTPS username `x-bitbucket-api-token-auth`, and opens the PRs tab of a `bitbucket.org` repository
- **THEN** the pull-request list loads, exactly as for a token saved under a personal username

#### Scenario: OAuth-signed-in account

- **WHEN** the account authenticates git as the OAuth sentinel username and the user lists pull requests
- **THEN** the pull-request list loads exactly as before this change

#### Scenario: Pull-request diff served through a redirect

- **WHEN** the user opens a pull request's diff and Bitbucket answers with a redirect to a repository diff on the same API host
- **THEN** the redirected request carries the token too, and the diff loads instead of a "you may not have access" error

#### Scenario: Git transport is unaffected

- **WHEN** the same account fetches or pushes over HTTPS
- **THEN** git still authenticates with the account's git HTTPS username, and the remote URL is not rewritten

### Requirement: A rejected Bitbucket token is reported distinctly from a missing one

When Bitbucket answers a pull-request call with HTTP 401, GitLane SHALL report that Bitbucket rejected the saved token, offer the fix-authentication action, and say where in Settings to save a new scoped API token. When no token is bound or none is in the keychain, GitLane SHALL report that no Bitbucket sign-in was found. The two messages MUST differ.

#### Scenario: Expired or revoked token

- **WHEN** the keychain holds a token for the bound account and Bitbucket answers a pull-request call with 401
- **THEN** the error says Bitbucket rejected the saved token, suggests creating an API token with scopes, and names the Settings → Accounts place to save it for pull requests
- **AND** it does not say that no sign-in was found

#### Scenario: Retired app password

- **WHEN** the saved credential is a Bitbucket app password and Bitbucket answers a pull-request call with 401
- **THEN** the user sees the rejected-token error, not the missing-sign-in error

#### Scenario: No token in the keychain

- **WHEN** a Bitbucket repository's pull requests are opened and no GitLane token exists for its host and account
- **THEN** the error says no Bitbucket sign-in was found, as it does today

### Requirement: The Bitbucket token never leaves the request header

The token SHALL travel only in the request's authorization header to Bitbucket's fixed API host. It MUST NOT appear in a URL, error message, log line, or anything returned over IPC, including any encoded form of it.

#### Scenario: Redirect to another host

- **WHEN** a Bitbucket pull-request call is redirected to a different host, or away from HTTPS
- **THEN** the redirected request carries no token

#### Scenario: Error from Bitbucket after a failed call

- **WHEN** a Bitbucket pull-request call fails and its error reaches the frontend
- **THEN** the error text contains neither the token nor any encoding of it
