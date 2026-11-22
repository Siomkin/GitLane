# Proposal

**Jira**: None.  
**Process touched**: Rust backend (`src-tauri/`, both desktop and headless `gitlane-agent` builds), plus one stale comment in `src/features/changes/agentRun.ts`. No frontend behaviour or IPC signature changes.

## Why

A security review of the repository identified six concrete code-level defense gaps across unattended ACP agent sessions, real-`git` CLI invocations, worktree file reads, and remote-agent credential helper construction. Closing these gaps prevents prompt-injected ACP agents from exfiltrating host files or environment secrets, keeps hand-pinned npm adapters out of the repository directory, eliminates the git option-injection vector on `git push`, blocks `.git/` metadata reads over worktree IPC, and enforces uniform authority validation before shell interpolation.

One reviewed finding is not acted on: a leading `-` in a `git config` value. `git config <key> <value>` already stores such a value literally (checked on git 2.54: `git config user.name --global` writes the literal string), because option parsing stops at the key. See Non-goals.

## What Changes

- **Confine unattended ACP `read` and `search` tool calls to the open repository**: In `session/request_permission`, examine every string value the adapter reports for the call, whatever its key, and reject the call when any of them points outside the session `cwd` or inside `.git/`. A `read` that names no existing in-repo file fails closed. The gate judges only what the adapter reports; it cannot see a read the adapter performs without asking.
- **Harden ACP `execute` permission validation**: Reject `$` (preventing `$VAR` / `${VAR}` environment expansion), zsh process substitution (`=(`), ASCII control characters (`\r`, etc.), and `--ext-diff` in read-only git commands.
- **Keep shipped `npx` ACP adapters on `@latest`, and recognise them at any version**: the catalogue's `npx -y @agentclientprotocol/*` entries stay on `@latest`, and saved rows with no version still move onto it. A saved row naming any version is recognised as the catalogue package, so it still launches from the user's home directory rather than the repository and gets the package's install hint. Exact-version pins were tried and dropped: nobody would keep bumping them, so they would go stale (see design decision 3).
- **Close the `git push` option-injection gap**: Enforce `ensure_operand` on `remote` inside `run_push`, so a dash-led remote read from `branch.<name>.pushRemote`, `remote.pushDefault` or `branch.<name>.remote` is refused by every production push caller.
- **Block `.git/` reads in worktree file-reading commands**: Reject `.git` path components case-insensitively in the `worktree_fs` functions that open file content for reading, matching the existing guard in `git/write/path_guards.rs`. Fingerprint and append helpers are left alone.
- **Enforce credential-authority validation on the remote-agent `gh` path**: Call `validate_credential_authority` on both `remote_host` and `account.host` in `pick_server_gh`, as the desktop path already does.

## Capabilities

### New Capabilities

_(None — all changes strengthen existing capabilities.)_

### Modified Capabilities

- `terminal/session`: Require unattended ACP `read`/`search` tool approvals to stay inside the session repository (excluding `.git/`), reject `$`, `=(`, control characters, and `--ext-diff` in unattended `execute` approvals, drop `fetch` from kind-based approval (the code already rejects it), and launch a catalogue `npx` adapter outside the repository whatever version it names.
- `platform/git-invocation`: Require every `git push` remote operand to be guarded against option injection, and require remote-agent `gh` credential helper construction to validate host authorities before shell interpolation.
- `platform/security`: Require operations that return worktree file content over IPC to refuse paths inside `.git/` (case-insensitively), matching worktree writes and path guards.

## Non-goals

- **macOS Developer ID signing and notarization** (`signingIdentity: "-"` in `tauri.conf.json`): already specified in `openspec/specs/platform/security/spec.md` and controlled by release-CI Apple credentials rather than a backend code change.
- **Frontend or Tauri IPC contract changes**: no new commands, DTO changes, or Zustand store edits.
- **Interactive ACP permission UI**: unattended turns continue to auto-approve only strictly confined read-only operations and fail closed on everything else.
- **Pinning or bundling `npx` adapters**: the shipped adapters keep running `@latest`; pinning exact versions and bundling Node.js adapters into GitLane are both out of scope.
- **`--` before `git config` key/value operands**: no vector was reproduced, so no code or requirement is added. Reopen only if a supported git version (the floor is 2.36) is shown to parse a value after the key as an option.
- **Moving saved adapter rows that name a version**: such a row is the user's own pin, so it is left alone.

## Secrets, Auth, and IPC Risk

- No provider tokens cross IPC or enter JS/Zustand; no new secret-carrying IPC commands are added (`approve_https_credential`, `save_provider_token`, and `answer_ssh_prompt` remain the only secret-bearing commands).
- This change **reduces** secret-exposure risk by: (1) preventing prompt-injected ACP agents from reading host secrets (`~/.ssh`, `~/.aws`, `.git/config`) or expanding secret environment variables via `execute`, (2) blocking IPC reads of `.git/config` via `repo_file_text` / `read_binary_blob`, and (3) ensuring `pick_server_gh` validates host authorities identically to `credential_for_credential_host` before building the inline `gh` credential helper.

## Existing Patterns to Reuse

- Path confinement: the canonicalising comparison in `stays_in_cwd` (`src-tauri/src/acp/session/permission.rs`) and the `.git` component check in `src-tauri/src/git/write/path_guards.rs`.
- Git option guards: `ensure_operand` in `src-tauri/src/git/write/operands.rs` (already used by `pull_branch` and `fetch`).
- Host authority validation: `validate_credential_authority` in `src-tauri/src/git/transport_auth.rs`.

## Impact

- **Backend modules**: `src-tauri/src/acp.rs`, `src-tauri/src/acp/session/permission.rs`, `src-tauri/src/acp/catalogue.rs`, `src-tauri/src/acp_agents.rs`, `src-tauri/src/git/write/remotes/transport.rs`, `src-tauri/src/git/worktree_fs/` (`handle.rs`, `reads.rs`), `src-tauri/src/git/transport_auth.rs`, and a doc comment in `src-tauri/src/git/credential_bridge.rs`.
- **Both Rust targets**: desktop (`--all-features`) and remote agent (`--no-default-features --features agent`).
- **Tests**: Unit tests in each touched module; no new dependencies or Tauri plugins.
