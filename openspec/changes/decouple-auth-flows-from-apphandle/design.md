## Context

See proposal.md — Why. Engine: forge/oauth (`git/oauth`, `git/forge/signin`); no libgit2 read, no git CLI write. IPC layers: impl and command bodies change; handler registration, serde types (`ProviderOauthProgress`, `SignInProgress`, `ProviderOauthResult`, `GithubSignInResult`) and `src/lib/api` do not. Store: none. No new dependency (`docs/tauri-plugin-decisions.md` not engaged).

What already exists and is reused: `HttpTransport` trait + mock (`git/oauth/http/transport.rs`), `SecretStore` trait + `MemoryStore` (`secrets.rs`), `client_ids::{get_in,set_in}(dir: &Path)`, `drive_reader(app, Box<dyn Read>, Box<dyn Write>, …)` (already stream-generic), and the clone progress-callback shape.

## Goals / Non-Goals

**Goals:**

- No `tauri::` path under `src-tauri/src/git/`, enforced by a test.
- The OAuth orchestration and the `gh` PTY milestone machine are unit-tested without a runtime, network, or OS keychain.

**Non-Goals:**

- New traits. Every seam needed already exists; this change only injects them.
- Changing what is emitted, when, or to whom.

## Decisions

### 1. `&dyn Fn(&Payload)` per flow, not a shared sink trait

`progress: &dyn Fn(&ProviderOauthProgress)` for OAuth and `&dyn Fn(&SignInProgress)` for `gh` sign-in, identical to `clone(&progress, …)`. `drive_reader` runs on a detached thread, so its callback is `Arc<dyn Fn(&SignInProgress) + Send + Sync>` built once in the command. Alternative — an `EventSink` trait implemented for `AppHandle` — rejected: it keeps a Tauri-shaped abstraction inside `git/` and a closure is already the project's idiom. _As built:_ the `gh` sink is spelled `SignInProgressSink` (a type alias for `Arc<dyn Fn(&SignInProgress) + Send + Sync>` in `signin/slot.rs`, re-exported by `git::forge`), because `commands/github.rs` names it too; it is an alias, not a trait.

### 2. Inject `http` and `store` into `run_sign_in_inner` only

`run_sign_in` (public, called by `commands/auth.rs`) keeps constructing `UreqTransport` and `KeyringStore`, so the command layer learns nothing new about OAuth internals; only the private inner function gains parameters. With `progress`, `client_ids_dir`, `slot`, `provider`, `host`, `http`, `store` that is seven arguments — group the environment ones in a private `struct SignInEnv<'a> { progress, client_ids_dir, http, store, clock }` rather than tripping `clippy::too_many_arguments`.

_As built:_ `clock: &dyn Clock` joined the env. `run_device` hard-coded `&RealClock`, so without it a device-flow test would sleep the provider's real poll interval. The `Clock` trait already existed (`device.rs`), so it is one more injected seam, not a new one. The test clock must be virtual — `sleep` advances `now()` — because the poll loop waits for `now()` to reach the next poll; a no-op `sleep` over a real `now()` spins for the full interval. `run_device`/`run_pkce` now take the env and drop their `#[allow(clippy::too_many_arguments)]`.

### 3. The command layer owns handle → path/closure adaptation

`commands/auth.rs` gets one private helper `oauth_client_ids_dir(&AppHandle) -> Option<PathBuf>` (the body of today's `client_ids::data_dir`, `.ok()`) used by its three commands (`provider_oauth_sign_in`, `oauth_client_status`, `set_oauth_client_id`). **Read paths take `Option<&Path>`**: today `client_ids::get` is `get_in(&data_dir(app).ok()?, …)`, so an unresolvable app-data dir silently falls back to the compile-time client id and sign-in proceeds. Returning `Result` from the helper would turn that into a hard error — a behaviour change this `skip_specs` refactor must not smuggle in. Only `set_client_id` errors on `None`, exactly as `client_ids::set` does now. `client_ids::get`/`set` wrappers and `data_dir` are deleted; `get_in`/`set_in` are renamed to `get`/`set`.

### 4. Guard: a source-scan test, like `registration_tests`

A test under `commands/registration_tests/` walks `src-tauri/src/git/**/*.rs`, strips `//` comment lines, and fails on `tauri::` or `AppHandle`. Alternative — moving `git/` into its own crate without a `tauri` dependency — is the structurally perfect guard and far too large for the payoff; note it in the rules text as the long-term shape only if the scan ever proves insufficient. `git/types/error.rs` mentions `#[tauri::command]` in a doc comment only; the comment strip covers it.

## Risks / Trade-offs

- A test-only `MemoryStore` path diverging from `KeyringStore` behaviour (e.g. key validation) → `key.validate()` stays before the store call and is exercised by the new tests; keychain-specific behaviour keeps its existing coverage in `secrets.rs`.
- The `Arc<dyn Fn + Send + Sync>` for the PTY thread captures an `AppHandle` clone → same lifetime as today's `app.clone()` into the thread; no new retention.
- Touching token-handling code for a refactor → mitigated by a pure-signature diff (no reordering of `begin_credential_commit` / `emit("storing")` / `store.set`), the new "no token in any progress payload" assertion, and an end-to-end manual check in `bun run tauri dev` (task 4.2).
