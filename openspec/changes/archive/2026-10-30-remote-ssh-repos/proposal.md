# Proposal

## Why

Many developers keep their repositories on a remote machine (a dev box, a build
server, a cloud VM) and reach them over SSH. Editors already work there (VS Code
Remote-SSH, Zed remote, JetBrains Gateway), but GitLane can only open a local path,
so those repositories are out of reach. No mainstream desktop git GUI supports
this today. The code must stay on the server: GitLane may show results, but must
not copy the repository or its history to the local machine.

Jira: none yet.

## What Changes

- A repository can be opened as `ssh://<host>/<absolute-path>`, where `<host>` is
  anything the user's `ssh` accepts (a `~/.ssh/config` alias, `user@host`, a
  ProxyJump target).
- GitLane connects with the user's own `ssh` binary, so their SSH config, agent
  and known_hosts apply unchanged. Questions `ssh` asks (password, passphrase,
  one-time code, trusting a new host key) appear as in-app dialogs. It never
  stores SSH passwords or keys.
- The open dialog needs no ssh syntax: host, user and port fields with
  suggestions, then a folder browser on the server.
- GitHub remotes on the server authenticate with the server's own `gh` login,
  and the toolbar shows the repository's hosting provider.
- On first connect (and after each app update), GitLane uploads a headless
  `gitlane-agent` binary through that same connection into
  `~/.gitlane-server/<version>/` on the server. The server needs `git` 2.36+ and
  sshd, nothing else, and no internet access.
- The agent runs GitLane's existing git core on the server: libgit2 reads, real-`git`
  writes, and a file watcher. Only command results and change events cross the
  connection.
- Remote repositories support history/graph, search, diffs, status, staging,
  commit, branch operations, merge/rebase/cherry-pick/revert/reset, conflicts,
  stash, worktrees, identity cards, and live updates.
- Fetch, pull and push on a remote repository run on the server with the
  server's own credentials. GitLane's bound accounts, `gh` token injection and
  keychain credential bridge do not apply there.
- Every command is either served for remote repositories or rejected with a
  distinct `unsupportedOnRemote` error, and the UI disables the matching actions
  instead of failing late.
- A dropped connection shows a reconnect state for that tab, modelled on the
  existing missing-repository state. Other tabs are unaffected.
- First supported servers: Linux x86_64 and aarch64 (static musl agent builds).

## Non-goals

- Copying code or history to the local machine (no mirror, no partial clone).
- A git-only mode with no agent. It was rejected because it needs a second read
  engine (see design.md).
- The integrated terminal, ACP/terminal agents and pull-request features for
  remote repositories. Each is a planned follow-up and returns
  `unsupportedOnRemote` here.
- Editing files in the repository file workspace. The source view is read-only
  on remote repositories.
- macOS, Windows or BSD servers.
- Sending any secret (provider token, HTTPS credential, OAuth token) to the server.
- A built-in SSH client library, or managing SSH keys or hosts inside GitLane.

## Capabilities

### New Capabilities

- `remote/ssh-repos`: opening a repository on another machine over SSH. Covers
  the connection lifecycle, agent install and version matching, which features
  are available on a remote repository, live updates, and the disconnected state.

### Modified Capabilities

- `ipc/commands`: every command must be declared either remote-capable or
  local-only. A local-only command rejects a remote locator with
  `kind: "unsupportedOnRemote"`. A request that can't reach the server (not
  connected, or the connection dropped) rejects with `kind: "remoteUnavailable"`.
  The two secret-carrying commands are always
  local-only. Errors from the agent pass the same redaction and classification
  rules as local ones.
- `platform/git-invocation`: the requirement that fetch/pull/push/clone present
  the bound forge account's credential applies to local repositories only. A
  remote repository's transport uses the server's git configuration and credentials.

## Impact

- **Processes:** Rust (new agent binary, connection manager, forwarding), IPC
  (remote locator, new error kind, classification test), frontend (open-remote
  entry, capability gating, reconnect state), and release CI (two Linux musl
  agent targets).
- **Rust:** the `git/` core must build without Tauri. It already contains no
  Tauri code (`commands/registration_tests/tauri_free_core.rs`), but `tauri` is an
  unconditional dependency of `gitlane_lib` today. `keyring`, used by the
  credential bridge, must be excluded from the agent build.
- **Patterns to copy:**
  - The re-entrant binary role in `git::credential_bridge` (`lib.rs` checks
    `is_askpass_invocation()` before starting Tauri), as the model for running in a
    different role.
  - The closed `SYNC_BY_DESIGN` list in `commands/mod.rs`, enforced by
    `registration_tests/thread_placement.rs`, for the closed `LOCAL_ONLY` list.
  - The clone progress slot (`git::write::lifecycle::CloneSlot`) for agent-install
    progress.
  - The missing-repository state (GL-108) for the disconnected tab.
- **Frontend:** the single `invoke()` in `src/lib/api/invoke.ts` stays the only
  IPC path. Stores keep keying repositories by their locator string.
- **Secrets/auth risk:** the agent runs with the user's own authority on their
  server, so it grants no new privilege there. The risk is leakage: no token,
  credential or `GH_TOKEN` may be forwarded, and SSH agent forwarding is never
  enabled implicitly. Agent upload must verify the binary it installed (size and
  checksum) before running it.
- **Dependencies:** no new Rust SSH crate. The system `ssh` (OpenSSH) is required
  on the client. Windows OpenSSH lacks connection multiplexing, which does not
  matter here because the agent keeps one long-lived session.
