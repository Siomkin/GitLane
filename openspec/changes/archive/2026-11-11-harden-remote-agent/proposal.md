# Proposal

## Why

A security review of the SSH remote agent (2026-11-11) found no network hole: the agent opens no port and is reachable only through the user's own SSH login. It found four places where someone who is not the user could still get code to run as the user on a server, or make the desktop act on a path the server chose. Each fix is a few lines, so they go together.

There is no Jira issue for this change.

## What Changes

The change touches the Rust core only. No IPC command, type or frontend file changes.

- **Agent directory is private and owned.** The install script creates `~/.gitlane-server/` with the login umask. Under umask 002 with a shared primary group, a group member can replace the agent binary, or plant one for a future version, and it runs as the user on a later connect. The directory tree becomes owner-only, an existing install is tightened on the next connect, and an agent file or directory owned by another account is never run or written into.
- **Every upload is signature-checked.** A downloaded agent is verified, but the copy GitLane keeps in app data is uploaded later with no check. The kept copy is verified on every use, and a copy that fails is thrown away and downloaded again.
- **No verification bypass in release builds.** `GITLANE_AGENT_PATH` uploads an unsigned agent in any build. It is honoured in development builds only.
- **A server's change notices stay on that server.** A `repo-changed` path from the agent is joined to the host's origin without a check, so a path such as `.other.example/x` names a different host. A path that is not absolute is dropped.

## Non-goals

- No change to the wire protocol, the command table, the askpass flow or any UI.
- No comparison of an agent already on the server with the signed binary. Ownership is checked; content is not. See design.md.
- No restriction of host and user names to a character set. OpenSSH 9.6 and newer already refuse shell metacharacters there, and locators are typed or saved by the user only.
- No lower frame-size limit. A safe number needs measurements of real graphs first.
- No release-workflow edit. Pinning the agent build image, the fifth item from the same review, is the separate change `pin-agent-build-image`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `remote/ssh-repos`: the installed agent becomes private to the connecting user, and only an agent that user owns is run; "Only a verified agent is installed" now covers GitLane's kept copy and forbids a bypass in release builds; a server's change notices apply only to paths on that server.
## Impact

- `src-tauri/src/remote/install.rs` (install script, probe script, cache, override) and `install/tests.rs`. Copy the existing script tests there (`run_remote`, `the_install_script_installs_checks_and_prunes`).
- `src-tauri/src/remote/forward.rs` (`to_webview_event`) and its tests.
- `CLAUDE.md` and `docs/manual-verification-backlog.md`, which describe the cache and the override.
- **Secrets and auth:** no secret is added, moved or logged. The change only removes ways to run an unverified binary. The three commands that may carry a secret are untouched.
- **Users:** the first connect after the update downloads the agent once more for a server that needs an install, because the old unverified cache file is no longer read.
