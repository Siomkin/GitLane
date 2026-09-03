## Purpose

Defines the contract every Tauri command honours when it fails: what crosses IPC, where errors are classified and redacted, and how the frontend reports failed reads so no failure is silently rendered as "nothing there".

## ADDED Requirements

### Requirement: Backend events have one declared name and a typed payload

Every event the backend emits to the webview MUST have exactly one declared name shared by the emitter and the listener, and a declared payload type that exists on both sides of IPC. A payload that does not match its declared type MUST be reported as an IPC validation error rather than silently ignored.

#### Scenario: progress event payload mismatch is visible
- **WHEN** the backend emits a progress event whose payload lacks the declared `step` field
- **THEN** the frontend reports an IPC validation error naming the event, and the progress checklist does not advance

#### Scenario: renamed event cannot drift
- **WHEN** an event name is changed on one side only
- **THEN** the parity test fails before the change ships

### Requirement: Every command response is validated at the API seam

Every command response consumed by the frontend MUST be checked against its declared schema before it reaches a store or component. A malformed response MUST surface as a named IPC validation error identifying the command and offending fields.

#### Scenario: backend field renamed without updating the frontend
- **WHEN** a command returns an object missing a required field
- **THEN** the caller receives an error naming the command and the field, and no component dereferences `undefined`

### Requirement: Repository reads keep the interface responsive

A read command whose duration depends on repository size (working tree status, branch listing, diffs, remote and forge inspection) MUST run off the webview main thread so the interface continues to repaint while it runs.

#### Scenario: working-tree status on a large repository
- **WHEN** the user opens a repository with tens of thousands of tracked files and triggers a status read
- **THEN** spinners keep animating and the window responds to input until the status arrives

### Requirement: External tool availability is re-checked without restart

The availability and capability level of `git`, `gh`, `glab`, and `origin` MUST be re-probed after an explicit retry or account/settings change, so installing or upgrading a tool during a session takes effect without relaunching GitLane.

#### Scenario: gh installed after launch
- **WHEN** `gh` was missing at launch, the user installs it, and then retries the PR list
- **THEN** the PR list loads without restarting the app

#### Scenario: git upgraded during a session
- **WHEN** the git version check failed at launch and the user upgrades git and retries a write
- **THEN** the write proceeds without restarting the app

### Requirement: List and blob responses are bounded

Every command that returns a list of paths, commits, or file bytes MUST enforce a documented maximum and MUST indicate truncation when the maximum is hit. Callers that need more MUST page or narrow the request.

#### Scenario: repository file list beyond the bound
- **WHEN** the repository has more tracked and untracked paths than the file-list bound
- **THEN** the response contains at most the bound, flags truncation, and the file panel shows that the list is partial

### Requirement: Exactly two commands may carry a user-entered secret

Only the HTTPS credential approval command and the provider-token save command MAY declare a parameter that is a credential (a password, token, or secret). Each MUST hand the secret to its OS-backed store (`git credential approve` or the keychain) and MUST NOT persist, log, echo, or return it. No other command MAY declare a credential parameter, and no store state, persisted setting, event payload, or log line MAY contain a credential. Free-form user text (terminal keystrokes, commit messages, file contents) is outside this rule.

#### Scenario: provider token saved from settings
- **WHEN** the user pastes a personal access token and saves it
- **THEN** the token reaches the keychain, the response reports only success and non-secret account metadata, and the token appears in no store state, localStorage entry, or log line

#### Scenario: a new command tries to accept a secret
- **WHEN** a command other than the two above declares a parameter named or documented as a token, password, or secret
- **THEN** the secret-path audit test fails
