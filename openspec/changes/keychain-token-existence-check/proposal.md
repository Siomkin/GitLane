# Proposal

## Why

On macOS, GitLane asks for the login keychain password several times at launch, once per saved provider token. The launch check only needs to know whether each token still exists, but it reads the secret to find out, and macOS guards every secret read by an app that is not yet on the item's allowed list. Release builds are ad-hoc signed, so every update is a new app to the keychain and the prompts return after each one.

There is no Jira issue for this change.

## What Changes

- Checking whether a GitLane-owned provider token exists no longer reads the secret on macOS. It matches the keychain item by its attributes only, which macOS does not guard with a prompt.
- The secret is read only when a token is actually used: fetch, pull, push, clone, and pull-request operations.
- A repository that uses a keychain token for pull requests still reads the secret when it opens, because GitLane loads its pull requests automatically. That includes the repository restored at launch, so one prompt can remain there.
- Windows and Linux keep the current behaviour (the check reads the entry). Windows does not prompt. On Linux a locked keyring can ask to be unlocked when the entry is read; this change does not alter that.
- Process: Rust only. No IPC change: `provider_token_status` keeps its arguments and its `ProviderTokenStatus` result.

## Non-goals

- Removing the keychain prompt when a token is used, including the automatic pull-request load when a repository opens. That needs releases signed with a stable Developer ID, which is a release-signing decision outside this change.
- Caching tokens or token existence in memory, in the frontend, or on disk.
- Changing where or how tokens are stored, saved, or deleted.
- Changing the existence check on Windows or Linux.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `accounts/transport`: adds a requirement that checking whether a saved keychain token exists must not read the secret on macOS, so the check raises no keychain access prompt.

## Impact

- **Code:** `src-tauri/src/secrets.rs` (the `SecretStore` trait and `KeyringStore`), `src-tauri/src/git/provider_tokens.rs` (`provider_token_status_in`). Pattern to copy: the existing `SecretStore` methods and their `MemoryStore` test double in the same file.
- **Callers:** `reconcileProviderTokens` in `src/store/accounts/credentials.ts`, run at launch from `src/store/accounts/forgeAuth.ts` and from the Accounts settings panel. Unchanged; they benefit through the same command.
- **Dependencies:** `keyring-core` becomes a direct macOS dependency in `src-tauri/Cargo.toml`. It is already in `Cargo.lock` as a dependency of `keyring`, so nothing new is downloaded or compiled. It is a Rust crate, not a Tauri plugin, so `docs/tauri-plugin-decisions.md` does not apply.
- **Secrets / auth / IPC risk:** lower than today. The check stops loading the token into process memory. No command gains a credential parameter, nothing new crosses IPC, and no token reaches JS or Zustand.
- **Remote agent build:** unaffected. The agent's `KeyringStore` holds no secrets and keeps the default behaviour.
