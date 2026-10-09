# Proposal

## Why

When a GitHub HTTPS remote is bound to a `gh` account that is not `gh`'s
*active* account, fetch / pull / push fail with an auth error and a "Remote
access" settings toast, even though both accounts are signed in and healthy.
The only workaround today is `gh auth switch --user <login>`, which flips the
user's global `gh` state for every terminal and every other repository.

The cause is a wrong assumption in the transport layer: GitLane injects
`!gh auth git-credential` and relies on the remote URL username to pick the
account (as Git Credential Manager does). `gh` does not work that way: its
helper answers only for the active account and returns nothing when the
requested username differs. Reproduced on gh 2.102.0 with two github.com
accounts:

| Probe (`gh auth git-credential get`) | Result |
|---|---|
| `username=<inactive login>` | empty, so git gets no credential |
| `username=<active login>` | credential returned |
| `GH_TOKEN=<inactive account's token>`, any username | that token, as `x-access-token` |

On a public repository, fetch and pull go through anonymously, so the failure
shows up on push. On a private repository it hits every network operation.

The pull-request surface is not affected, according to CLI probes; this was not
reproduced in the app. It already resolves
`gh auth token --hostname <host> --user <login>` and pins the result through
`GH_TOKEN`, and pinned PR calls work for both accounts.

Jira: none.

## What Changes

- The GitHub `gh` transport credential carries the bound account's login, not
  only the host.
- The inline git credential helper GitLane injects for GitHub remotes resolves
  that login's token (`gh auth token --hostname <host> --user <login>`) at
  credential-request time and hands it to `gh auth git-credential` through
  `GH_TOKEN` / `GH_ENTERPRISE_TOKEN`. Fetch / pull / push / clone therefore
  authenticate as the bound account whichever account `gh` has active, the same
  way the PR surface already does.
- If the bound account has no token, the helper fails outright and never falls
  back to the active account.
- The login is checked against a strict GitHub-login charset before it reaches
  the helper command string. The charset covers github.com, EMU, and GHES. A
  malformed binding is rejected with a readable error.
- Fix the doc comments and project docs that state `gh` selects the account by
  URL username.

Process touched: **Rust only** (`src-tauri/src/git/`). No IPC shape change, no
frontend change, no new dependency.

## Non-goals

- No `gh auth switch`, and no other mutation of the user's global `gh` state.
- No change to the PR / forge path (`forge/cli/command.rs`, `gh_provider.rs`).
  It already pins correctly.
- No change to GitLab (`glab`), provider-token, or system credential-helper
  modes. `glab` is single-account per host, so this mismatch cannot occur there.
- No change to how the UI picks the bound account, or to the "Remote & PR as"
  picker.
- No new error classification or toast copy. Once transport authenticates
  correctly, the misleading toast no longer fires for this case.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `accounts/transport`: ADDED requirement. Git network operations on a GitHub
  remote bound to a `gh` account authenticate as that account regardless of
  `gh`'s active account, never fall back to another account, and never change
  global `gh` state.

## Impact

- **Code**:
  - `src-tauri/src/git/transport_auth.rs`: `TransportCredential::Gh` gains
    `gh_host` and `login` fields, filled from the already-validated
    `account_ref`.
  - `src-tauri/src/git/credential_bridge.rs`: `gh_helper_config` builds the
    account-pinned helper.
  - Doc comment in `src-tauri/src/git/types/auth.rs`.
  - Callers via `git_invocation`: `write/remotes/transport.rs` and
    `write/lifecycle/clone.rs`. Their signatures do not change.
- **Pattern to copy**: the PR path's `forge/cli/accounts.rs::token_for` plus
  `forge/cli/command.rs::run_gh_command`. That code resolves per-login, exports
  `GH_TOKEN` and `GH_ENTERPRISE_TOKEN`, and drops the token.
- **Secrets / auth risk**:
  - The token is resolved inside the credential-helper subprocess and exists
    only in that `gh` process's environment.
  - It is never in git's environment, so hooks never see it. Git children stay
    insulated by `PROVIDER_TOKEN_ENV_VARS`.
  - It never crosses IPC, and never touches JS or Zustand.
  - The new risk is shell injection through values interpolated into a `!`
    helper string. The host is already interpolated and validated. The login
    gets strict validation as well, and both are single-quoted.
  - No new secret-bearing command.
- **Docs**: CLAUDE.md (GitHub / multi-account section),
  `docs/rules/architecture-rules.md` §2, `docs/rules/architecture-rules-rust.md`
  around the `GitTransportAuthRef` note.
- **Platforms**: Git for Windows runs `!` helpers through its bundled `sh`, so
  the helper form works on all three OSes.
