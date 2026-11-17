# Proposal

## Why

Security audit run-3 (2026-11-17) found two places where data an SSH server supplies can steer the desktop, and a unit test reproduces each one today:

- `withLocator` (`src/lib/paths.ts`) glues a server-reported path onto the tab's `ssh://origin` without requiring a leading `/`. A path such as `@evil.example/srv/x` turns `ssh://devbox` into `ssh://devbox@evil.example`, and the app connects to that host with no user action.
- The askpass listener (`src-tauri/src/remote/askpass.rs` `decide`) replays a remembered secret to any later `ssh` of the same connect attempt whose prompt text is identical. A prompt that names no host, such as a server's keyboard-interactive `Password: `, is replayed too, so an answer typed for one server can reach a different one (for example, another ProxyJump hop). On OpenSSH older than 8.4 a server can also copy ssh's own wording (`me@jump's password: `), because ssh passes its keyboard-interactive text through unmarked.

There is no Jira key for this change.

## What Changes

- **Frontend:** a server path that does not start with `/` is refused when it is turned into a locator. Opening the repository or listing worktrees then fails with an error instead of connecting to another host. A worktree path the user types on a remote tab is checked before the worktree is created, not after.
- **Rust:** the agent's reported home directory is dropped unless it starts with `/`, so the open-remote folder browser starts at `/` instead.
- **Rust:** the askpass listener replays a remembered answer only when the local `ssh` is OpenSSH 8.4 or newer and the prompt names its target: ssh's `user@host's password:` form, `Enter passphrase for key '<path>':`, or a prompt carrying OpenSSH's `(user@host) ` prefix. With an older or unrecognised `ssh`, and for any other prompt, the user is asked every time. On 8.4 and newer the one-password-per-connect behaviour is kept for named prompts.
- The two failing tests already added during the audit (`src/lib/paths.remote.test.ts`, `src-tauri/src/remote/askpass/tests.rs`) become passing regression tests.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `remote/ssh-repos`: adds the requirement "A path the server reports stays on that server", mirroring the existing change-notice rule. Modifies "The connection uses the user's own SSH setup and asks in the app" so that an answer is reused only for a named prompt on OpenSSH 8.4 or newer.

## Non-goals

- No change to how ssh is spawned, to host-key handling, or to the agent protocol.
- No validation of agent responses beyond the path fields that become locators and the home directory.
- Not addressing the other run-3 leads (Open > Default Application, the CI trusted-user gate, the updater manifest, ACP app-data spawn) or the hardening notes.
- No change to which IPC commands carry secrets: `answer_ssh_prompt` stays the only path for an SSH answer, and the answer is still never stored, logged or sent to the server.

## Impact

- Processes: frontend (`src/lib/paths.ts`, `src/store/repoWriteActions/worktrees.ts`) and Rust (`src-tauri/src/remote/askpass.rs` plus a new `src-tauri/src/remote/askpass/replay.rs`, `src-tauri/src/commands/remote.rs`). No IPC command, argument or type changes.
- Secrets/auth risk: the askpass change only narrows when a secret is replayed. The worst case of a too-strict rule is extra password dialogs, most visibly on Windows 10, whose bundled OpenSSH is 8.1.
- Pattern to copy: the absolute-path check in `src-tauri/src/remote/forward.rs` (`to_webview_event`) for both path fixes; `src-tauri/src/shell/timed.rs` for running `ssh -V` with a timeout; the existing `decide`/`classify` tests in `src-tauri/src/remote/askpass/tests.rs`.
