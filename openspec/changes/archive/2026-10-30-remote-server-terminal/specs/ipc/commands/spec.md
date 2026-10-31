# Spec Delta

## MODIFIED Requirements

### Requirement: Local-only commands reject a remote locator with unsupportedOnRemote

When a local-only command receives an `ssh://` repository locator as the repository it acts on, it SHALL reject with `kind: "unsupportedOnRemote"`, naming the command, without contacting the server. This SHALL NOT apply to local-only commands that reach a locator's host themselves, such as connecting to a host, testing a connection, or opening a remote repository's terminal.

#### Scenario: Reveal requested for a remote repository

- **WHEN** the frontend asks to reveal `README.md` of `ssh://devbox/srv/app` in the file manager
- **THEN** the call rejects with `kind: "unsupportedOnRemote"`, and no connection to `devbox` is made for it

#### Scenario: Terminal requested for a remote repository

- **WHEN** the frontend opens a terminal for `ssh://devbox/srv/app`
- **THEN** the call is not rejected with `kind: "unsupportedOnRemote"`, and the terminal's `ssh` runs on this computer and connects to `devbox`
