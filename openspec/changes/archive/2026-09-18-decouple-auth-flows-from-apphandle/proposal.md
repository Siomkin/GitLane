## Why

`src-tauri/src/git/` is meant to be reachable without a Tauri runtime: `git/write/lifecycle/clone.rs` says so in its module doc ("Progress reaches the caller as a callback rather than an `AppHandle` so the clone is reachable…") and `commands/repo.rs::clone_repo` builds the `events::emit` closure at the command boundary. A 2026-09-18 audit found the two auth flows are the only `git/` code that does not follow it — `tauri::AppHandle` appears in exactly five files under `git/` (other `tauri` mentions there are doc comments):

- `git/oauth/mod.rs` — 8 functions take `app: &AppHandle` (`run_sign_in`, `run_sign_in_inner`, the device and PKCE wrappers, `resolve_client_id`, `client_status`, `set_client_id`, `emit`), for two purposes: emitting `provider-oauth-progress` and locating the app-data dir for `client_ids`.
- `git/oauth/client_ids.rs` — `get`/`set` take `&AppHandle` only to call `app.path()`; the file already has `get_in(dir)`/`set_in(dir)` for exactly this reason (its doc: under `tauri::test` the handle resolves to the developer's real Application Support), so the handle-taking wrappers are the only part left to remove.
- `git/forge/signin/{flow,pty,slot}.rs` — `sign_in_web` and the PTY reader take `&AppHandle` only to emit `github-signin-progress`.

The cost is test reach. The OAuth module was built around a mockable `HttpTransport` so the flows unit-test offline, and `device/` and `pkce/` are tested that way — but the orchestration in `oauth/mod.rs` (client-id resolution → flow → `authorized` → `storing` → keychain commit) has 7 tests, all on the cancel slot, because everything else needs an `AppHandle`. Likewise `signin/tests.rs` has 13 parser/probe tests and none for `pty.rs`'s milestone state machine (`code → browser → authorized`, each emitted once). These are the sign-in paths where an out-of-order or duplicate step is user-visible and a regression is an auth bug.

Jira: none yet. Process: Rust only. No IPC change — same commands, same event names and payloads. `skip_specs: true`: behaviour-preserving refactor plus tests; `harden-provider-oauth-sign-in` (archived 2026-09-15) owns the behavioural spec and is not altered.

## What Changes

- `git/oauth`: `run_sign_in(progress: &dyn Fn(&ProviderOauthProgress), client_ids_dir: Option<&Path>, slot, provider, host)`; inner wrappers take the same `progress`; `resolve_client_id`/`client_status` take `dir: Option<&Path>` (preserving today's silent fallback to the compile-time client id when the app-data dir cannot be resolved); `set_client_id` and `client_ids::set` take `dir: &Path`. The private `emit` helper builds the payload and calls `progress`.
- `run_sign_in_inner` stops constructing its collaborators: it takes `http: &dyn HttpTransport` and `store: &dyn SecretStore` (both traits already exist, with a mock transport and `secrets::MemoryStore`); the public `run_sign_in` builds `UreqTransport::new()` and `KeyringStore::new()` and passes them in. Without this, removing `AppHandle` alone would still leave the orchestration untestable — a test would hit the network and the developer's real keychain.
- `git/forge/signin`: `sign_in_web(progress: &dyn Fn(&SignInProgress), slot, host)`; `pty.rs`/`slot.rs` thread `progress` instead of `app`.
- `commands/auth.rs` (3 commands) and `commands/github.rs` (1) resolve `app.path().app_data_dir()` and build the `crate::events::emit(&app, …)` closure — the exact shape `commands/repo.rs::clone_repo` uses today.
- New tests: OAuth orchestration against the existing mock `HttpTransport` with a recording `progress` (step order for device and PKCE; `storing` is never emitted after a cancel; redaction still wraps the error); `signin/pty` milestone sequence from a canned transcript (each step once, in order). `client_ids` keeps its existing directory-based tests; `get_in`/`set_in` become the public `get`/`set`.
- Rule: one ❌ line in `docs/rules/architecture-rules-rust.md` "Anti-patterns (Rust)" — `tauri::AppHandle`/`Manager`/`Emitter` under `src-tauri/src/git/`; progress is a callback, paths are `&Path`, the command layer adapts — plus a registration-style test that greps `git/**/*.rs` for `tauri::` outside comments.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- None — `skip_specs: true`: signatures inside the Rust core change; commands, events, payloads, and keychain behaviour do not.

## Impact

- Rust: `src-tauri/src/git/oauth/{mod,client_ids}.rs`, `src-tauri/src/git/forge/signin/{flow,pty,slot}.rs`, `src-tauri/src/git/forge.rs` (re-export signature), `src-tauri/src/commands/{auth,github}.rs`, new test modules beside each, one guard test under `commands/registration_tests/`.
- Frontend / IPC: none. `provider-oauth-progress` and `github-signin-progress` keep their names and camelCase payloads; `lib/api` untouched.
- Size ceiling: `git/oauth/mod.rs` is 461 lines with inline tests; new orchestration tests go to `git/oauth/tests.rs` (the `signin/tests.rs` shape) so the production count does not grow.
- Secrets/auth risk: low, and called out — this touches the OAuth token path. The token still goes flow → keychain inside `run_sign_in_inner` and is never passed to `progress`; `ProviderOauthProgress` has no token field and gains none. `redact_secrets` stays the outermost wrapper of `run_sign_in`. New tests assert the recorded progress payloads contain no access token from the mock transport.
- Pattern to copy: `git/write/lifecycle/clone.rs` (`progress: &dyn Fn(&CloneProgress)`) and `commands/repo.rs::clone_repo`.

## Non-goals

- Removing the `TOOL_PROBES` static or other process-wide state (its module doc already justifies it).
- A generic `EventSink` trait — two closures do not need one.
- Any change to OAuth endpoints, scopes, client-id precedence, cancel semantics, or the `gh` PTY protocol handling.
- Moving `git/oauth` or `git/forge/signin` out of `git/`.
