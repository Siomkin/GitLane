## Purpose

Defines the contract every Tauri command honours when it fails: what crosses IPC, where errors are classified and redacted, and how the frontend reports failed reads so no failure is silently rendered as "nothing there".

## Requirements

### Requirement: Command failures cross IPC as a structured error

When any command fails, the rejection value delivered to the frontend MUST be an object with a machine-readable `kind`, a human-readable `message`, and an optional `detail` string. It MUST NOT be a bare string. `kind` values are a closed set that includes at least: `git` (CLI reported failure), `hookRejected`, `auth`, `network`, `staleLease`, `indexLock`, `conflict`, `notARepository`, `missingPath`, `forge`, `internal`.

#### Scenario: git CLI rejection carries a kind and the redacted message
- **WHEN** a write command's `git` subprocess exits non-zero
- **THEN** the rejection has `kind: "git"` (or a more specific kind when classified), `message` holds the redacted stderr summary, and `detail` may hold the full redacted output

#### Scenario: libgit2 read failure is typed
- **WHEN** a read command cannot open or read the repository
- **THEN** the rejection has `kind` `notARepository`, `missingPath`, or `internal` and a `message` free of libgit2 class/code jargon

#### Scenario: hook rejection names the hook
- **WHEN** `git commit` is refused by a `pre-commit` or `commit-msg` hook
- **THEN** the rejection has `kind: "hookRejected"`, `detail` includes the hook name, and `message` is the hook's own reason line rather than task-runner noise

### Requirement: Error classification happens in the backend

The category of a failure MUST be decided where the failure is observed (the process that ran `git`, `gh`, `glab`, `origin`, or libgit2). The frontend MUST NOT need to pattern-match on CLI text to choose a category, copy, or recovery action; it MAY still pattern-match to *format* copy.

#### Scenario: authentication failure on push
- **WHEN** a push is refused because the remote rejected the credential
- **THEN** the rejection arrives as `kind: "auth"` and the frontend offers the sign-in / credential recovery path without inspecting `message`

#### Scenario: stranded index lock
- **WHEN** a staging command fails because `.git/index.lock` exists and no git process holds it
- **THEN** the rejection arrives as `kind: "indexLock"` and the existing index-lock recovery dialog opens based on `kind` alone

#### Scenario: stale optimistic lease
- **WHEN** a leased write finds the expected OID or state no longer matches
- **THEN** the rejection arrives as `kind: "staleLease"` and the frontend refreshes and re-prompts rather than showing a generic error bar

### Requirement: Every error crossing IPC is redacted at one chokepoint

Any error rejection delivered to the frontend MUST have passed through the secret redaction step regardless of which module produced it. Provider tokens, HTTPS passwords, URL-embedded credentials, and one-time device codes MUST be replaced by `***`.

#### Scenario: token in a git remote error
- **WHEN** `git fetch` fails with a message containing an `https://user:TOKEN@host/…` URL
- **THEN** the delivered `message` and `detail` contain `***` in place of the token

#### Scenario: forge CLI error containing a device code
- **WHEN** a GitHub sign-in child exits with output that includes the one-time device code
- **THEN** the delivered error does not contain the device code

### Requirement: Failed background reads are surfaced, not blanked

When a read that populates a UI section (worktrees, stashes, operation status, forge summary, PR stack) fails during a refresh, GitLane MUST show a non-blocking notification naming the section and MUST keep the last successfully loaded data (or an explicit "unavailable" state). It MUST NOT render the section as empty as if the repository had none.

#### Scenario: stash list read fails during refresh
- **WHEN** a repo refresh succeeds for the graph but the stash read rejects
- **THEN** the previously shown stashes remain visible (or the stash section shows "unavailable"), and a notification reports that stashes could not be read

#### Scenario: transient failure clears on next refresh
- **WHEN** the next refresh reads the section successfully
- **THEN** the "unavailable" state and its notification are cleared without user action

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
