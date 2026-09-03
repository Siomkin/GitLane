## Purpose

Defines the contract every Tauri command honours when it fails: what crosses IPC, where errors are classified and redacted, and how the frontend reports failed reads so no failure is silently rendered as "nothing there".

## ADDED Requirements

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
