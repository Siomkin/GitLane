## 1. Rust impl — `git/oauth`

- [x] 1.1 In `git/oauth/client_ids.rs` delete `data_dir`, `get(app…)`, `set(app…)` and rename `get_in`/`set_in` to `pub fn get(dir: &Path, …)`/`set(dir: &Path, …)`; verify the file has no `tauri` import and its 6 tests pass unchanged apart from the rename
- [x] 1.2 In `git/oauth/mod.rs` replace every `app: &AppHandle` with `progress: &dyn Fn(&ProviderOauthProgress)` and/or `client_ids_dir: Option<&Path>` (`&Path` for `set_client_id`) (`run_sign_in`, device/PKCE wrappers, `resolve_client_id`, `client_status`, `set_client_id`, `emit`); verify `grep -n "tauri\|AppHandle" git/oauth/mod.rs` prints nothing
- [x] 1.3 Add private `struct SignInEnv<'a> { progress, client_ids_dir, http: &'a dyn HttpTransport, store: &'a dyn SecretStore, clock: &'a dyn Clock }` (clock added at apply time — design.md §2); `run_sign_in_inner` takes it; `run_sign_in` builds it with `UreqTransport::new()` and `KeyringStore::new()`; verify the order `begin_credential_commit` → emit `storing` → `store.set` is byte-identical in the diff and `cargo clippy --all-targets --all-features -- -D warnings` is clean

## 2. Rust impl — `git/forge/signin`

- [x] 2.1 `flow.rs::sign_in_web(progress: Arc<dyn Fn(&SignInProgress) + Send + Sync>, slot, host)`; `slot.rs::emit` and `pty.rs::drive_reader` take the callback instead of `app`; `git/forge.rs` re-export unchanged by name; verify `grep -rn "tauri\|AppHandle" git/forge/signin` prints only comment lines

## 3. Commands

- [x] 3.1 `commands/auth.rs`: add `oauth_client_ids_dir(&AppHandle) -> Option<PathBuf>` (`.ok()` on the resolver — today `client_ids::get` swallows a dir failure and falls back to the compile-time client id, and that must not become an error); `provider_oauth_sign_in` and `oauth_client_status` pass `Option<&Path>`, `set_oauth_client_id` turns `None` into the existing "failed to resolve app data dir" error; the sign-in command builds `let progress = |p: &ProviderOauthProgress| crate::events::emit(&app, crate::events::PROVIDER_OAUTH_PROGRESS, p.clone());` and pass the dir — copy `commands/repo.rs::clone_repo`; verify `cargo check` passes and `commands/registration_tests` still pass (no signature visible to IPC changed)
- [x] 3.2 `commands/github.rs:33`: build the `Arc` progress closure for `GITHUB_SIGNIN_PROGRESS` and pass it to `git::forge::sign_in_web`; verify the `blocking_tests` module in `github.rs` still passes

## 4. Tests

- [x] 4.1 New `git/oauth/tests.rs` (move the 7 inline slot tests there too, so `mod.rs` production lines do not grow): with the mock `HttpTransport`, `MemoryStore`, a `tempdir` client-ids dir and a recording `progress`, assert (a) device flow emits `device_code`/`polling`/`authorized`/`storing` in order and the token lands in `MemoryStore` under the `oauth_account_id` key, (b) PKCE flow emits `browser`/`waiting`/`authorized`/`storing` in order, (c) a cancel set before `begin_credential_commit` yields `Err("Sign-in canceled.")`, no `storing` event and an empty store, (d) no recorded payload's debug string contains the mock access token, (e) an unknown provider / unconfigured host errors before any event; verify `cargo test git::oauth::` passes
- [x] 4.2 Extend `git/forge/signin/tests.rs`: feed `drive_reader` a canned `gh auth login` transcript via `Cursor` reader and `Vec<u8>` writer; assert `code`, `browser`, `authorized` are each emitted exactly once in order even when the code line repeats, and the parsed login lands in `ReaderShared`; verify `cargo test git::forge::signin::` passes
- [ ] 4.3 (NOT RUN — needs a human: real GitLab, Bitbucket and GitHub sign-ins) Manual in `bun run tauri dev`: GitLab device-flow sign-in (code shown → authorized → account appears), Bitbucket PKCE sign-in, cancel mid-flow, GitHub web sign-in via `gh`, set and clear a custom OAuth client id in Settings; verify each behaves as on `latest`

## 5. Guard and rules

- [x] 5.1 Add a test under `commands/registration_tests/` that scans `src-tauri/src/git/**/*.rs`, ignores `//`-comment lines, and fails on `tauri::` or `AppHandle`; verify it passes now and fails if `use tauri::AppHandle;` is re-added to `git/oauth/mod.rs`
- [x] 5.2 `docs/rules/architecture-rules-rust.md`: one paragraph in §4 (progress is a `&dyn Fn` callback, locations are `&Path`, the command layer adapts — cite `clone.rs`) and one ❌ in "Anti-patterns (Rust)"; update the `CLAUDE.md` OAuth paragraph's mention of the app-data client-id file to say the command layer resolves the directory; verify both name the guard test

## 6. Definition of done

- [x] 6.1 `(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test)`, `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run sizes`, and `openspec validate decouple-auth-flows-from-apphandle --strict` all pass
