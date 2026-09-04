## Why

The audit produced a set of findings with no spec impact: dependency drift, advisory warnings, duplicate crate/package versions, a handful of `expect`/`unreachable!` sites worth documenting, logging inconsistency, and cohesion hotspots. They are collected here as tasks so the behavioural changes stay focused.

No Jira key (GL-xx) for this change. Touches Rust dependencies, frontend dependencies, CI config, and docs. `skip_specs: true` — no observable behaviour changes.

## What Changes

### Repository map (for context, no action)

- 717 commits since 2026-06-22 (73 days); every tracked source file was touched within the last three months, so there is no "dead area" by the >1 year metric.
- Highest churn (commits in the last 6 months): `src-tauri/src/lib.rs` 77 (registration list — inherent), `src/lib/api/git.ts` 74 and `src-tauri/src/git/types.rs` 65 (facades — inherent), `src/store/repoTypes.ts` 64, `src/store/ui.ts` 58, `src/store/repoWriteActions.ts` 57, `src/store/accounts.ts` 37, `src/store/repoLifecycleActions.ts` 36.
- Churn × size hotspots are test files (`src/store/repo.test.ts` 5 120 lines × 60 commits; see `raise-command-test-coverage`) and, among production files, `lib.rs` (314 × 77), `ui.ts` (337 × 58), `accounts.ts` (384 × 37), `repoRefreshActions.ts` (399 × 21). All production files are under the 400-line ceiling (`scripts/file-size-baseline.json` is `{}`); `ui.ts` (theme + panels + overlays + PR filters + drag + pins) is the cohesion outlier.
- `git log -S` counts across `src-tauri`: `unwrap()` 179 commits, `expect(` 138, `panic!` 27, `unsafe` 18. Current tree: one `unsafe` block (`git/write/open_path.rs:131`, Windows `ShellExecuteW`, sound).
- Secrets history: no content match for `ghp_`, `glpat-`, `AKIA`, or `PRIVATE KEY` in any revision; pathspec hits for `*token*`/`*secret*` are source files (`git/provider_tokens.rs`, `secrets.rs`).

### Rust `expect`/`unreachable!` outside tests (15 sites, all reviewed)

| Site | Verdict |
| --- | --- |
| `src-tauri/src/lib.rs:313` `.expect("error while running tauri application")` | Standard Tauri entry; cannot be handled. Keep. |
| `terminal_agents.rs:373` `defaults().pop().expect(…)` | `defaults()` is a non-empty literal. Cannot fire. |
| `redact.rs:110` `.chars().next().expect(…)` | `cursor < text.len()` on valid UTF-8 boundaries. Cannot fire. |
| `git/write/identity.rs:87` `identity.expect(…)` | Guarded by the `is_some_and` comparison two lines above. Cannot fire. |
| `git/write/remotes/config.rs:120` `.next().expect("length checked")` | `len() != 1` returns early at :115. Cannot fire. |
| `git/write/branches/deletion_transaction.rs:79,176,183` | `expect` is a method on the transaction type returning `Result`, not `Option::expect`. Not a panic. |
| `git/graph/layout/build.rs:167,264` `commit.as_ref().unwrap()` | `commit` is `Some` for every `Entry::Commit` by construction of the entry list. Cannot fire; replace with `let-else` for clarity. |
| `git/status/selection/ordering.rs:50` `.take().expect("each index used once")` | `order` is a permutation of indices. Cannot fire. |
| `git/forge/bounded_output/capture.rs:100` `unreachable!` | Stream names are fixed literals. Cannot fire. |
| `capture.rs:141,142` `.expect(…)` | Reached only after both reader threads joined `Ok`; each `Ok` path sets its `Option`. Cannot fire. |
| `git/transport_auth.rs:177` `unreachable!` | `System`/`Ssh` return earlier in the same fn. Cannot fire; refactor to a match on the remaining variants. |

`.lock().unwrap()` in production code: none (only the OAuth test double, `git/oauth/http/testing.rs:45,57`). Poisoned locks are handled with `unwrap_or_else(PoisonError::into_inner)` or `map_err` (`identity.rs`, `index_lock.rs`, `terminal.rs`, `watcher.rs`).

### Dependencies — Rust

- `cargo audit` (policy in `src-tauri/.cargo/audit.toml`, CI `ci.yml:160-165`): 16 `unmaintained` warnings — the GTK3 binding family ×10 (`RUSTSEC-2024-0411…0420`, Linux-only via `tauri-runtime-wry`), `proc-macro-error` (`RUSTSEC-2024-0370`), `unic-*` ×5 (`RUSTSEC-2025-0075/0080/0081/0098/0100`, via `urlpattern` → `tauri-utils`); one ignored `unsound` (`RUSTSEC-2024-0429`, `glib`, documented). All transitive through Tauri; nothing actionable except re-checking on each Tauri bump.
- `cargo outdated`: `keyring` 3.6.3 → 4.2.0 (features `apple-native`, `windows-native`, `sync-secret-service`, `crypto-rust` are obsolete in 4.x), `ureq` 2.12.1 → 3.4.0 (`tls` feature obsolete), `tauri-plugin-dialog` 2.7.2 → 2.7.3, `tauri-plugin-opener` 2.5.4 → 2.5.5, `tauri-plugin-updater` 2.10.1 → 2.11.0.
- `cargo tree --duplicates` (587 crates): `thiserror` 1.0.69 + 2.0.18, `syn` 2 + 3, `sha2` 0.10 + 0.11 (+ `digest`, `crypto-common`, `block-buffer`, `cpufeatures`), `getrandom` 0.2 + 0.3 + 0.4, `indexmap` 1 + 2 (+ `hashbrown` 0.12 + 0.17), `png` 0.17 + 0.18, `webpki-roots` 0.26 + 1.0, `io-lifetimes` 2 + 3. GitLane's direct pins are `sha2 = "0.11"` and `getrandom = "0.4"` (`src-tauri/Cargo.toml`); the older lines are held transitively — `sha2` 0.10 by `tauri-codegen` and `getrandom` 0.2 by `ring` → `rustls` (`cargo tree -i`) — so they cannot be removed by GitLane alone.

### Dependencies — frontend

- `bun outdated`: `zod` 4.4.3 → 4.5.4, `typescript` 6.0.3 → 7.0.2 (major), `happy-dom` 20.11.12 → 20.13.2, `typescript-eslint` 8.68 → 8.69, `@testing-library/user-event`, `@types/react-dom`, the three Tauri plugin packages (must move in lockstep with the Rust plugins above).
- `bun.lock` duplicates (29 packages): `lightningcss` 1.32/1.33 ×12 platform packages, `@tauri-apps/api` 2.11.0/2.11.1, `entities` 6/7/8, `semver` 6/7, `whatwg-url` 16/17, `parse5` 7/8, `lru-cache` 5/11, `escape-string-regexp` 4/5, `ignore` 5/7.
- `depcheck` flags `@types/bun` and `tailwindcss` as unused — both are false positives (`scripts/*.ts` run under bun; `tailwindcss` is the peer of `@tailwindcss/vite`). No unused dependency found.
- `bun audit`: timed out locally (network); CI runs it (`ci.yml:151`). **Not verified** in this audit.

### Logging and drift

- Rust has no logging facade: 9 `eprintln!` sites (`acp_agents.rs`, `git/forge/prs/commits.rs`, `git/forge/gitlab/ops.rs`, `git/forge/signin/slot.rs`, `git/forge/bitbucket/ops.rs`, `git/forge/threads.rs`) and 1 `println!`. The sign-in one is `#[cfg(debug_assertions)]`-gated (`slot.rs:40-42`); the others print in release. Frontend: 3 `console.warn` (`src/components/chrome/action-bar/useActionBarModel.ts:158`, `src/store/repoWriteActions/shared.ts:26`, `src/store/repoWriteActions/remotes.ts:157`) and no `console.error`/`console.log`.
- Date representation drift: forge types use ISO strings (`git/types/forge.rs:168,236,334,369` `created_at`/`authored_date`) while git types use unix seconds `i64` (`git/types/graph.rs:48`, `git/types/files.rs:46,81`). IDs: PR `number: u64` ↔ TS `number`; OIDs `String`. snake_case/camelCase: every IPC struct under `git/types/` carries `rename_all = "camelCase"`; the 30 structs without it are external-JSON deserialisers (`git/forge/dto/**`, `git/oauth/**`, `git/credential_bridge/broker.rs`) and never cross IPC.
- Per-repository write locks are leaked `&'static Mutex` entries (`git/write/index_lock.rs:25`, `git/write/identity.rs:16-17`, `Box::leak` at first use) — one small allocation per distinct repository for the process lifetime, by design; no action.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- None. `skip_specs: true` — dependency, docs, and cleanup work only.

## Impact

- `src-tauri/Cargo.toml`, `Cargo.lock`, `package.json`, `bun.lock`, `.cargo/audit.toml`, `docs/tauri-plugin-decisions.md`, `docs/rules/architecture-rules-rust.md`, `CLAUDE.md`.
- Secrets/auth/IPC risk: the `keyring` 4 and `ureq` 3 upgrades touch the keychain and OAuth HTTP paths; both are behind trait/module seams (`secrets.rs`, `git/oauth/http/`) with mock-backed tests.

## Non-goals

- Splitting `src/store/ui.ts` (cohesion outlier) — behaviour-preserving but large; propose separately if wanted.
- Introducing a logging crate with file output (a product decision about log persistence).
- Any change to test structure (see `raise-command-test-coverage`).
