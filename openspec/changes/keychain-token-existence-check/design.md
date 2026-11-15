# Design

## Context

See proposal.md for motivation. `provider_token_status` (`src-tauri/src/git/provider_tokens.rs`) answers "does this token still exist" with `store.get(&key)?.is_some()`. On macOS, `KeyringStore::get` goes through `keyring` → `apple-native-keyring-store`, whose `get_secret` calls `find_generic_password`. That call returns the password data, and reading data is what the keychain's per-item access list guards.

The frontend's `reconcileProviderTokens` calls the command once per saved token, in parallel, at launch and when the Accounts panel opens. Each call on an item this build is not yet allowed to read raises its own prompt.

Engine: neither libgit2 nor the git CLI nor a forge provider. This is the OS keychain behind `SecretStore` in `src-tauri/src/secrets.rs`.

## Goals / Non-Goals

**Goals:**

- The existence check on macOS reads no secret.
- The check stays behind `SecretStore`, so tests keep using an in-memory double.

**Non-Goals:**

- A no-read check on Windows or Linux.
- Any IPC, type, or frontend change. The four IPC layers stay as they are: impl changes inside `git/provider_tokens.rs`; the command and its `generate_handler!` line, `ProviderTokenStatus`, and `src/lib/api/providers.ts` are untouched.
- Any Zustand store change. `accounts` keeps calling the same wrapper.

## Decisions

**1. Add `exists` to `SecretStore` with a default that reads.**
`fn exists(&self, key) -> Result<bool, SecretError>` defaults to `Ok(self.get(key)?.is_some())`. Only the macOS `KeyringStore` overrides it. `MemoryStore`, the agent build's `KeyringStore`, and the Windows and Linux stores inherit the default, so their behaviour does not change.
*Alternative:* change `provider_token_status` to call a macOS-only free function. Rejected: it bypasses the trait, so the status tests could no longer run against a double.

**2. On macOS, implement `exists` with `keyring_core::Entry::search`.**
The search is given `service` and `user` and returns the matching entries. `apple-native-keyring-store` implements it with `ItemSearchOptions` and `load_attributes(true)`, without loading data, so the access list is not consulted. An empty result means the token is absent; the store already maps "no entry" to an empty result.
*Alternative:* call `security-framework`'s `ItemSearchOptions` directly. Rejected: it duplicates what the store already does and bypasses the store `keyring` configured (which keychain to search).
*Alternative:* `Entry::get_credential` / `get_attributes`. Rejected: on this store both call `find_generic_password`, which reads the data and prompts.

**3. Name `keyring-core` as a direct macOS dependency.**
`keyring`'s `v1` API does not re-export `Entry::search`, and a crate must be a direct dependency to be named. `keyring-core` 1.x is already locked, so the build graph does not grow. It is optional and enabled by the `desktop` feature next to `dep:keyring`.

**4. Initialise the store before searching.**
`keyring` sets the default store on the first `keyring::Entry::new`. `exists` builds the entry first (which also validates the key), then searches.

**Size ceiling:** `secrets.rs` goes from 292 to 371 lines, inside the Rust look band (251–400). About 130 of those lines are tests. No split in this change: the file is one trait, its production store, and its test double.

## Risks / Trade-offs

- [The no-prompt claim rests on macOS behaviour] → An ignored real-keychain test creates an item no app may read (`security add-generic-password -T ""`) and asserts `exists` answers; a secret read of that item blocks on the prompt. It first confirms that a secret read of that item blocks, and it fails after ten seconds instead of hanging. It is ignored because it needs a real keychain, so CI does not run it; a comment beside the dependency says to rerun it after a bump. The in-app manual checks stay as tracked tasks.
- [A future `apple-native-keyring-store` release could change `search` to load data] → `keyring-core` and the store are pinned by `Cargo.lock`; that ignored test is rerun when either is upgraded, and it hangs instead of passing if `search` starts reading data.
- [`secrets.rs` is at 371 lines, 29 under the ceiling] → No split in this change; the next addition to the file must move its tests into a sibling module first.
- [A prompt can still appear at launch] → Opening a repository loads its pull requests automatically, and for a keychain-token account that reads the secret. This change removes the per-token prompts from the existence check only. Removing the rest needs stable release signing, or deferring the automatic load for such accounts, which is a product decision outside this change.
- [`exists` uses keyring-core's process-wide default store, which `keyring` installs] → `exists` contains a line that fails to compile if `keyring` and the direct dependency resolve to different keyring-core builds, and it asks `keyring` for the store status before searching.
- [`search` could match more than one item] → Service and account are both given, and the account string is collision-free, so at most one generic password matches. `exists` only tests for non-empty.
- [Prompts still appear when a token is used] → Accepted and stated in the spec. Removing them needs stable release signing.
