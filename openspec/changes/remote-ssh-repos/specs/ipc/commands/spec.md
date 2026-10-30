# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: Exactly two commands may carry a user-entered secret`
- TO: `### Requirement: Exactly three commands may carry a user-entered secret`

## MODIFIED Requirements

### Requirement: Exactly three commands may carry a user-entered secret

Only the HTTPS credential approval command, the provider-token save command and the SSH prompt answer command MAY declare a parameter that is a credential (a password, token, passphrase, or secret). The first two MUST hand the secret to their OS-backed store (`git credential approve` or the keychain); the SSH prompt answer MUST go only to the waiting `ssh` process's askpass helper for that one prompt. None of them MUST persist, log, echo, or return it. No other command MAY declare a credential parameter, and no store state, persisted setting, event payload, or log line MAY contain a credential. Free-form user text (terminal keystrokes, commit messages, file contents) is outside this rule.

#### Scenario: provider token saved from settings
- **WHEN** the user pastes a personal access token and saves it
- **THEN** the token reaches the keychain, the response reports only success and non-secret account metadata, and the token appears in no store state, localStorage entry, or log line

#### Scenario: SSH password answered
- **WHEN** the user types a password into the SSH prompt dialog
- **THEN** it reaches only the askpass helper of the `ssh` process that asked, and appears in no store state, event payload, or log line

#### Scenario: a new command tries to accept a secret
- **WHEN** a command other than the three above declares a parameter named or documented as a token, password, or secret
- **THEN** the secret-path audit test fails

## ADDED Requirements

### Requirement: Every command is declared remote-capable or local-only

Every command SHALL belong to exactly one of two closed sets: remote-capable (served for an `ssh://` repository locator) or local-only. The build SHALL fail when a command is in both sets or in neither.

#### Scenario: New command added without a classification

- **WHEN** a developer registers a new command without adding it to either set
- **THEN** the backend test suite fails and names the unclassified command

### Requirement: Local-only commands reject a remote locator with unsupportedOnRemote

When a local-only command receives an `ssh://` repository locator, it SHALL reject with `kind: "unsupportedOnRemote"`, naming the command, without contacting the server.

#### Scenario: Terminal requested for a remote repository

- **WHEN** the frontend asks to start a terminal for `ssh://devbox/srv/app`
- **THEN** the call rejects with `kind: "unsupportedOnRemote"`, and no connection to `devbox` is made for it

### Requirement: Unreachable servers reject with remoteUnavailable

A remote-capable command that cannot reach its server, because the host is not connected or the connection dropped while the call was in flight, SHALL reject with `kind: "remoteUnavailable"`. The message SHALL name the host.

#### Scenario: Connection drops mid-request

- **WHEN** the connection to `devbox` drops while a status read for one of its repositories is in flight
- **THEN** that read rejects with `kind: "remoteUnavailable"`, and its message names `devbox`

### Requirement: Secret-carrying commands are always local-only

The HTTPS credential approval command, the provider-token save command and the SSH prompt answer command SHALL be local-only. No command SHALL forward a credential parameter to a server.

#### Scenario: Saving a provider token while a remote tab is active

- **WHEN** the user saves a provider token while a remote repository tab is active
- **THEN** the token goes only to the local keychain, and nothing is sent to the server

### Requirement: Server folders can be listed for the open dialog

The backend SHALL list the sub-folders of one directory on a connected host, returning each one's name, whether it is a git repository, and whether it could be read. An unreadable entry SHALL be reported on that entry, not fail the listing. The listing SHALL run on the server and SHALL NOT read file contents.

#### Scenario: Home directory with a repository

- **WHEN** the dialog lists `/home/me` on `devbox`, which contains the repository `app` and the unreadable directory `secret`
- **THEN** the result marks `app` as a repository and `secret` as unreadable, and both are listed

### Requirement: Remote responses meet the same IPC contract as local ones

A remote-capable command's response and errors SHALL have the same shape, schema validation, error categories, size bounds and redaction as the same command on a local repository. A malformed response from the server SHALL be rejected at the API seam like a malformed local response.

#### Scenario: Server error contains a token

- **WHEN** a git command on the server fails with output containing a provider token
- **THEN** the error that reaches the frontend has the token redacted

#### Scenario: Malformed server response

- **WHEN** the server returns a response that does not match the command's declared schema
- **THEN** the call fails as a validation error, and the store keeps its previous data
