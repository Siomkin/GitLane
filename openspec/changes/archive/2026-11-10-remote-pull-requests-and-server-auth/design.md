# Design

## Context

- **The PR code already runs in the agent.** It sits under `git/forge/` and is not gated by `desktop` (only `forge/signin.rs` is). With `account: None`, `forge::service::context()` resolves the provider from the detected remote, and `gh` / `glab` run as their active login. On the server, that is the server's login.
- **PRs are switched off in three places.**
  - In Rust, the PR commands sit in `LOCAL_ONLY` (`commands/registration_tests/remote_split.rs`) and are absent from `agent/dispatch.rs`.
  - In the store, `src/store/pulls/list.ts:72` short-circuits for `isRemoteLocator`.
  - In the toolbar, `ActionBar.tsx:86` disables the PRs tab with `REMOTE_UNAVAILABLE`.
- **Bound accounts are stripped, but not PR accounts.** `agent::dispatch::without_accounts` removes `auth` and `remoteAccounts`, on the desktop in `remote/forward.rs` and again in `agent/run.rs`. PR commands carry their own `account` key, which it does not remove.
- **Bitbucket and GitLab tokens are unavailable on the agent.** Bitbucket uses REST with a keychain token, and the agent's `KeyringStore` always returns `None`. GitLab can use `glab` (the server's login) or REST with a keychain token. On the agent only `glab` can work.
- **Remote auth failures have no server-specific guidance.** The scenario "No credentials on the server" in `remote/ssh-repos` is not backed by a dedicated message. A remote auth failure surfaces as the generic redacted git error.
- **The tooltip is stale.** It is hard-coded in `src/components/chrome/action-bar/RemoteHostIndicator.tsx:35`.

## Goals / Non-Goals

**Goals:**
- One engine per concern:
  - PR reads and writes go through `forge::context()` on the agent.
  - The status probe reuses `forge::accounts()` and the `glab` auth check.
  - No new libgit2 or CLI paths.
- A remote auth failure, or a missing server login, always tells the user what to type on the server.

**Non-Goals:**
- Desktop-side sign-in to the server's forge.
- A server-account picker.
- New Tauri plugins or new JS dependencies.

## Decisions

1. **Make all PR commands remote-capable, not only the reads.** They move from `LOCAL_ONLY` to the agent table. Writes are safe here because they run under the server's own login, the same identity the user already pushes with on that server. The alternative was read-only. The user chose read and write.

2. **Strip `account` in `without_accounts`.** The function gains `map.remove("account")`. It runs on both sides, so a bound desktop account ref never reaches the server, and a hostile client cannot use one either. No PR command needs an account on the agent: `None` means the CLI's active login. The alternative, having the frontend send `null`, was rejected because it would rest on frontend discipline alone.

3. **Gate providers in Rust as well as in the UI.** On the agent build, the Bitbucket and Cursor Origin providers return a `CommandError` with `kind: "unsupportedOnRemote"` (the existing kind, see `ipc/commands`) and a message that names the provider. The frontend decides the PRs-tab state up front from `forge.kind`. It does not wait for the error.

4. **Add a new remote-capable probe, `forge_server_login(path)`.** It returns `{ provider: "gh" | "glab" | null, host, installed, supported, minVersion, login: string | null }`.
   - **gh:** it reuses `forge::accounts()`, then `pick_server_gh`-style matching on the remote host: active, healthy, host equal.
   - **glab:** it runs `glab auth status --hostname <host>`.
   - **Neither tool:** it returns `provider: null` for Bitbucket, Origin or an unknown forge.
   - **Commands:** the "command to run" is built in the frontend from `provider` and `host`, so no shell text crosses IPC.
   - It is classified remote-capable. On the desktop it returns the same shape for a local path, and nothing calls it there.
   - **The four IPC layers:**
     1. The implementation lives in `git/forge/` next to `accounts()` and is re-exported from `forge.rs`.
     2. The command is `#[tauri::command]` in `commands/github.rs`, added to `generate_handler!` in `lib.rs`, with an entry in `agent/dispatch.rs`.
     3. The type is `ForgeServerLogin` in `git/types/` (forge domain), camelCase.
     4. The TS wrapper and its zod schema go in `src/lib/api/github.ts`.

   The alternative, reusing `github_accounts`, was rejected: it takes no `path`, so `invoke()` would never route it to the server.

5. **The remote auth hint is added on the desktop side, in `remote/forward.rs`.** The desktop knows the host's display name. When a forwarded fetch, pull or push returns `kind: "auth"`, the message gets one hint built from the host and the remote's forge. The hint text matches the probe's command and adds "set up a credential helper on the server, or use an SSH remote URL". It is pure string shaping, done in a small helper next to `ssh_errors.rs`, with a unit test. The alternative was to build the hint in the agent. The agent does not know the user's name for the connection.

6. **Frontend changes.**
   - **Store and toolbar:** drop the `isRemoteLocator` short-circuit in `pulls/list.ts`. In `ActionBar.tsx`, disable PRs on a remote repository only when `forge.kind` is Bitbucket or Cursor Origin, with a provider-specific tooltip.
   - **Chip:** `RemoteHostIndicator` gets the corrected tooltip and shows the server login, for example "as octocat", from the probe. The probe is fetched once per tab connect and again on PR-panel retry. It is held in `src/store/remoteSessions.ts`, keyed by repo path, because that store already holds per-host remote state. No new store.
   - **PR panel:** on a remote repository its empty and error states render a hint with the probe's command and an Open terminal button. The button uses the existing terminal toggle, which opens `pty_spawn_remote` for remote tabs. PR write actions on a remote repository show "Runs on <host> as <login>".
   - **Remote accounts:** the account-binding UI already hides for remote repositories (`RemoteAccountPicker` uses `useIsRemoteRepo`). Nothing changes there.

## Implementation notes

These are where the code differs from the decisions above, found while applying the change:

- **PR commands moved to a new `commands/pulls.rs`.** `commands/github.rs` is compiled only into the desktop build, so the agent could not reach its PR commands. `github.rs` keeps the `gh` account commands (list, sign-in, sign-out). The 16 PR commands and `forge_server_login` moved to `pulls.rs`, which both builds compile. The TS wrappers stay in `src/lib/api/github.ts`.
- **The server command also appears in the frontend's friendly copy.** `friendlyGitError` (`src/lib/gitError.ts`) already rewrites a remote `credentialsMissing` error, which would hide the Rust hint. Its copy now carries the `gh`/`glab` login command, and the remote auth toast gains an **Open terminal** action. The Rust hint (`remote/server_auth.rs`) stays as the fallback for auth errors the frontend has no copy for.
- **`prAccountRef()` returns `null` for a remote repository.** That one point covers every PR call, so no call site changes.

## Risks / Trade-offs

- [PR writes act as a server identity the user may not expect] → The chip and each write action name the server login. When the login is unknown, writes are disabled.
- [`server_gh_accounts` caches for 5 min, so switching the active `gh` account on the server lags] → The cache only stores non-empty results, so the first login shows at once. The probe calls `forge::accounts()` directly and uncached, so the chip is always current. Only transport auth may lag.
- [A `glab` on the server that is too old or missing `auth status --hostname`] → It is reported as `supported: false` with the minimum version. GitLab PRs then stay in the error state with that hint.
- [File size] → `remote_split.rs` (173 lines) shrinks. `dispatch.rs` (193 lines) grows by about 17 entries and stays well under the Rust ceiling. `ActionBar.tsx` (252 lines) gains a few lines. If `bun run sizes` flags it, move the PR-tab gate into a helper in `action-bar/`.

## Migration Plan

No data migration is needed. Older agents do not have the PR entries. The agent is version-locked to the app (`install.rs` installs per version), so a desktop update installs an agent that does. Rollback is reverting the change.
