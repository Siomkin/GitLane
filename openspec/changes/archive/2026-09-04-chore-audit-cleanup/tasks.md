## 1. Rust dependencies

- [x] 1.1 Upgrade `keyring` to 4.x in `src-tauri/Cargo.toml` (per-platform feature names per its 4.x README), keeping the GitLane-namespaced service; verify `secrets.rs` tests and a manual save/read/delete of a provider token on macOS
- [x] 1.2 Upgrade `ureq` to 3.x behind `git/oauth/http/ureq_client.rs` (`HttpTransport` impl only), dropping the obsolete `tls` feature; verify the OAuth mock-transport tests and one real GitLab device-flow sign-in
- [x] 1.3 Bump `tauri-plugin-dialog`, `tauri-plugin-opener`, `tauri-plugin-updater` and their `@tauri-apps/plugin-*` JS twins in the same commit; verify `bun install --frozen-lockfile` and `cargo check`
- [x] 1.4 After 1.2, re-run `cargo tree --duplicates`; the `sha2` 0.10 (`tauri-codegen`) and `getrandom` 0.2 (`ring`/`rustls`) copies are transitive and stay — record them, with the crate that holds each, in `docs/tauri-plugin-decisions.md`; verify the list of GitLane-controllable duplicates is empty
- [x] 1.5 Add a note to `.cargo/audit.toml` listing the 16 accepted `unmaintained` advisories with the Tauri version they were last reviewed against; verify `cargo audit` output is unchanged

## 2. Frontend dependencies

- [x] 2.1 Bump `zod`, `happy-dom`, `typescript-eslint`, `@testing-library/user-event`, `@types/react-dom`; verify `bun run test` and `bun run lint`
- [x] 2.2 Evaluate `typescript` 7 on a branch (`bunx tsc --noEmit`, `bun run build`); record blockers or land it
- [x] 2.3 Dedupe `bun.lock` (`bun update` / `bun dedupe`) for `lightningcss`, `@tauri-apps/api`, `entities`, `semver`, `whatwg-url`, `parse5`; verify the duplicate count from the audit script drops below 10
- [x] 2.4 Run `bun audit` on a network-capable machine and record the result; verify CI's `security` job stays green

## 3. Rust cleanup

- [x] 3.1 Replace `commit.as_ref().unwrap()` at `git/graph/layout/build.rs:167,264` with `let-else` returning a layout error; verify `git/graph/tests` pass
- [x] 3.2 Refactor `git/transport_auth.rs:177` so the `System`/`Ssh` arms are matched explicitly instead of `unreachable!`; verify `transport_auth` tests
- [x] 3.3 Add `#[allow(clippy::expect_used)]` rationale comments (or `// INVARIANT:` notes) at the remaining reviewed `expect` sites listed in the proposal table; verify `cargo clippy -D warnings`
- [x] 3.4 Replace the 9 `eprintln!` / 1 `println!` sites with a tiny `crate::log` facade (`debug!`/`warn!` → stderr in debug, no-op or `log` crate in release); verify no stdout/stderr output in a release run of the PR list
- [x] 3.5 Document the date-representation split (ISO strings for forge, unix seconds for git) in `docs/rules/architecture-rules-rust.md`; verify the doc names `git/types/forge.rs` and `git/types/graph.rs`

## 4. Docs

- [x] 4.1 Record in `CLAUDE.md` that `updater::check_update_on_channel` moves under `commands/` (done in `harden-ipc-contract`) and that `src/store/ui.ts` is the cohesion watch-list item; verify `bun run sizes` still passes
- [x] 4.2 Run `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test && cargo audit)`, `bun run sizes`, `openspec validate chore-audit-cleanup --strict`; verify all pass
