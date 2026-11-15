# Tasks

## 1. Rust impl: secret store

- [x] 1.1 Add `keyring-core = { version = "1", optional = true }` to the macOS target dependencies in `src-tauri/Cargo.toml` and `"dep:keyring-core"` to the `desktop` feature; verify `(cd src-tauri && cargo check)` passes and `Cargo.lock` gains no new package entry
- [x] 1.2 Add `SecretStore::exists` in `src-tauri/src/secrets.rs` with a default of `Ok(self.get(key)?.is_some())`; verify the agent build compiles with `(cd src-tauri && cargo clippy --all-targets --no-default-features --features agent -- -D warnings)`
- [x] 1.3 Override `exists` for the macOS `KeyringStore` using `keyring_core::Entry::search` with `service` and `user`, after validating the key and asking `keyring` for the store status; verify by extending `keyring_store_roundtrips_on_macos` to assert `exists` is true after save and false after delete, and run it with `(cd src-tauri && cargo test --lib keyring_store_roundtrips_on_macos -- --ignored)`
- [x] 1.4 Add the ignored test `keyring_exists_answers_for_an_item_it_may_not_read`, which creates a keychain item no app may read (`security add-generic-password -T ""`), confirms a secret read of it blocks, and asserts `exists` returns true within ten seconds; verify it passes with `(cd src-tauri && cargo test --lib keyring_exists_answers_for_an_item_it_may_not_read -- --ignored)` and returns instead of blocking on the access prompt

## 2. Rust impl: token status

- [x] 2.1 Switch `provider_token_status_in` in `src-tauri/src/git/provider_tokens.rs` from `store.get(&key)?.is_some()` to `store.exists(&key)?`; verify `(cd src-tauri && cargo test --lib provider_tokens)` passes
- [x] 2.2 Verify `(cd src-tauri && cargo fmt --all -- --check)` and `(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)` pass
- [x] 2.3 Add a `provider_tokens` test with a store double whose `get` fails and whose `exists` returns true, asserting `provider_token_status_in` reports `has_token: true`; verify the test fails if the function is switched back to `get`

## 3. Docs

- [x] 3.1 Add one sentence to the provider-token paragraph of `CLAUDE.md` saying the existence check reads no secret on macOS and why; verify the paragraph still matches `secrets.rs`

## 4. Integration checks

- [x] 4.1 Run `bun run sizes`; verify `src-tauri/src/secrets.rs` stays under the ceiling
- [x] 4.2 In a build macOS has not yet allowed to read the saved tokens (a fresh `bun run tauri dev` binary, with at least one keychain token saved), launch the app and open Settings → Accounts; verify no keychain prompt appears and the token account still shows as signed in
- [x] 4.3 In the same build, fetch from a remote that authenticates with that token; verify macOS asks once for that token and the fetch succeeds after Allow
- [x] 4.4 Give the app a saved-token entry whose keychain item is absent (as after deleting the item in Keychain Access), then relaunch and open Settings → Accounts; verify the entry is dropped, the account shows no keychain token, the real tokens stay, and no prompt appears
