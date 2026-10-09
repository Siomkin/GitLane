# Tasks

## 1. Resolve and validate the bound login (`git/transport_auth.rs`)

- [x] 1.1 Change `TransportCredential::Gh { host }` to `Gh { host, login }` and update its doc comment. It currently says the account is "chosen by URL username". Make it say the login pins the helper's token. Verify with `cargo check`.
- [x] 1.2 Add a pure `validate_gh_login(&str) -> Result<(), String>`: 1–100 chars, `[A-Za-z0-9._-]`, no leading `-`, with the error "GitHub account binding is invalid; choose the account again." Unit-test it with `octocat`, `octocat_acme`, and `a.b-c` accepted, and with `''`, `-x`, `bob'; rm -rf ~; '`, `a b`, `a\nb`, and 101 chars rejected. Verify with `cargo test transport_auth`.
- [x] 1.3 Add a shell-safe gh-host check for the value passed to `gh auth token --hostname`: `account_ref.host` with the scheme stripped, the same normalization as `forge::domain::host_without_scheme`. Expose that helper through `forge.rs` rather than copying it. Allow `[A-Za-z0-9.-]` with an optional `:port`, or a bracketed IPv6 literal. Unit-test that a quote, `$`, `;`, and a space are rejected. Verify with `cargo test transport_auth`.
- [x] 1.4 In `credential_for_credential_host`'s `GithubGh` arm, run both validations, then return `Gh { host: actual_credential_host, login }`. Update `github_helper_preserves_custom_port`, `github_helper_matches_www_host_but_preserves_scope`, and `same_login_on_different_github_hosts_stays_distinct` to expect the login. Add a test that a malicious `account_ref.login` returns `Err`. Verify with `cargo test transport_auth`.
- [x] 1.5 Fix the module doc at the top of `transport_auth.rs` and the `GitTransportAuthRef` doc in `git/types/auth.rs`. Both claim gh resolves the account "for that username". Say instead that gh answers only for its active account, and that GitLane pins the bound login's token inside the helper. Verify by reading the diff.

## 2. Build the account-pinned helper (`git/credential_bridge.rs`)

- [x] 2.1 Change `gh_helper_config(host)` to `gh_helper_config(host, gh_host, login)`. It emits the clear-then-set pair, with the set value being the D1 shell function: single-quoted `--hostname` and `--user`, an `|| exit 1` fail-closed guard on an empty or failed token, and `GH_TOKEN` plus `GH_ENTERPRISE_TOKEN` exported only to `exec gh auth git-credential "$@"`. Update the `git_invocation` doc ("`None`/`Gh` carry no env…") and the comment block above `gh_helper_config` that claims the URL username selects the account. Verify with `cargo check`.
- [x] 2.2 Update `git_invocation_gh_clears_then_sets_gh_helper` to assert the exact new config strings and that `inv.env` is still empty, which proves no token goes into git's environment. Verify with `cargo test credential_bridge`.
- [x] 2.3 Add a `#[cfg(unix)]` end-to-end helper test, following the stub-script pattern already in this file. Put a stub `gh` first on `PATH`: `auth token --user bob` prints `tok-bob`, any other user exits 1, and `auth git-credential get` prints `username=x-access-token` and `password=$GH_TOKEN`. Run `git -c <helper config> credential fill` with `protocol=https host=github.com username=alice`. Isolate git from the developer's own helpers: `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `HOME=<tempdir>`, `GIT_ASKPASS=` and `GIT_TERMINAL_PROMPT=0`, with `GH_TOKEN` and its siblings unset. Otherwise an inherited osxkeychain helper could answer with a real token. This is the one check that the `-c` value, with its embedded quotes, survives git's command-line config parsing, which is D1's load-bearing assumption. Assert that login `bob` yields `password=tok-bob`, and that a login the stub refuses yields no password and a non-zero exit, meaning no fallback. Verify with `cargo test credential_bridge`.
- [x] 2.4 Confirm `write/remotes/transport.rs::run_transport` and `write/lifecycle/clone.rs` need no change beyond compiling. Their doc comments call `None`/`Gh` "byte-identical to a plain `run_git`", so reword them to "carry no env". Verify with `cargo check` and `cargo test --lib write::`.

## 3. Docs and rules

- [x] 3.1 CLAUDE.md, GitHub / multi-account section: replace "GitHub remotes can inject `gh auth git-credential` per invocation" and the accounts-store line ("GitHub can resolve to `gh auth git-credential`") with the pinned-login behaviour, and note that gh's helper answers only for its active account. Verify by reading the diff.
- [x] 3.2 `docs/rules/architecture-rules.md` §2 (around line 113) and `docs/rules/architecture-rules-rust.md` (around line 180): state that the GitHub transport helper pins the bound login's token in the helper subprocess only, never in git's env. Verify by reading the diff.

## 4. Definition of done

- [x] 4.1 `(cd src-tauri && cargo fmt --all -- --check)`, `cargo clippy --all-targets --all-features -- -D warnings`, and `cargo test` all pass. Run them through the `verify` agent.
- [x] 4.2 `bun run sizes` and `bun run cycles` report no growth, and `bunx tsc --noEmit` passes. No TS change is expected, so this is a sanity check.
- [ ] 4.3 Manual check in `bun run tauri dev`, with two github.com accounts in gh and the inactive one bound to the remote (`https://<inactive>@github.com/...`). On a public repo such as `Siomkin/GitLane`, git fetches anonymously, so only **push** exercises the helper. Use push as the signal there, or use a private repo where fetch and pull also ask. Check: push (and fetch/pull on a private repo) succeeds with no auth toast, and `gh auth status` shows the same active account before and after. Then sign the bound account out of gh and confirm that push fails with an auth error rather than succeeding as the active account. GHES cannot be covered locally; it rests on the shared `GH_ENTERPRISE_TOKEN` contract with the PR path.
- [x] 4.4 `openspec validate pin-gh-transport-account --strict` passes.

## Notes

- 1.1: The variant is `Gh { host, gh_host, login }`, not `Gh { host, login }`. A `www.github.com` remote with a `github.com` account must ask gh for the token under `github.com`, while the helper stays scoped to the remote's spelling. So the account's gh hostname travels separately.
- 1.3: No new host check and no `forge.rs` re-export. `account.host` already passes `validate_credential_authority`, which rejects `/` (so no scheme can be present) and allows only `[A-Za-z0-9.-]` plus a port, or a bracketed IPv6 literal. That is already shell-quote-safe. The task's injection cases (quote, `$`, `;`, space) are pinned by `github_helper_refuses_an_account_host_that_could_escape_the_helper_shell`.
- 2.3: In addition to the stub test, the real helper string was run by hand against real gh 2.102.0 with `Siomkin` active. Pinned to the inactive `SiomkinAlexander`, `git credential fill` returned that account's own token. A login gh doesn't know exited 128 with no password.
- 4.2: The new end-to-end test pushed `credential_bridge.rs`'s inline test half to 466 lines, over the 400-line ceiling (`bun run sizes`). The `git_integration` module (both real-git end-to-end tests) moved to `credential_bridge/git_integration.rs`, declared `#[cfg(all(test, unix))] mod git_integration;` next to `mod broker;`. No behaviour change, and the design's size-ceiling note is superseded.

- Code-review follow-ups, all landed:
  - The gh capability gate now runs on transport resolution.
  - The helper skips the lookup for `store`/`erase` and reads the token from `</dev/null`.
  - `SHELLOPTS`/`BASHOPTS` are cleared on every git child; the insulation test is extended.
  - `gh_host` is normalized with `forge::host_without_scheme`.
  - The host-injection test asserts the charset error.
  - The end-to-end test gained a GHES (`GH_ENTERPRISE_TOKEN`) case and a check that `store` never runs a token lookup, and its temp dir is cleaned up even when an assertion fails.
  - Not taken: moving gh transport onto the `GIT_ASKPASS` broker (design D1 alternative). That would be a design change.

## Workflow follow-up

- Archive the change after review (`/opsx:archive`), which syncs the ADDED requirements into `openspec/specs/accounts/transport/spec.md`.
