# Tasks

## 1. Provider auth (AUDIT items 1, 20, 72)

- [x] 1.1 Call `stream.set_nonblocking(false)` after `accept()` in `credential_bridge/broker.rs` `serve`, and change the drip-feed test to a non-blocking listener; verify that the test fails without the fix on macOS and that `cargo test credential_bridge` passes.
- [x] 1.2 Expose the write layer's provider-token env clearing and locale pin as one `pub(crate)` helper and apply it in `git/credentials.rs` `credential_git_command`; verify with an argv/env test that `GH_TOKEN` and `GITLAB_TOKEN` are cleared, and fix the `credential_bridge.rs:110-112` comment.
- [x] 1.3 Make `cancel_sign_in` (forge/signin/flow.rs) and the OAuth cancel (oauth/mod.rs) record a cancel only while a flow is pending; verify with a test that cancels after completion and then signs in successfully.

## 2. GitHub (items 6, 45)

- [x] 2.1 Delete `GhProvider::map` and map every write through `GithubError::from_command_in(ctx, …)`; verify with a GHES provider test on one write path that the auth hint names the GHES host and bound login.
- [x] 2.2 Change `prs/*` and `threads.rs` to return `Result<_, CliError>`, and map REST `ResponseTooLarge` to `outputTooLarge`; verify that an over-limit list read yields code `outputTooLarge`.

## 3. Web links (item 7)

- [x] 3.1 Build `RepoForge.web_url` from `api_host_for(url)` with the remote's scheme; verify with `summary` tests for `https://host:8443/…`, `http://host/…` and an scp remote.

## 4. Origin (items 22, 23, 25)

- [x] 4.1 Add `map_origin_error` and use it in `origin/ops.rs` `run`/`run_diff`; verify that a signed-out fixture yields kind `auth`.
- [x] 4.2 Route the Settings Origin whoami through `run_bounded` / `probe_origin`, and fix the `auth_providers/status.rs:59-62` comment; verify with a test that a hung probe returns within `PROBE_TIMEOUT`.
- [x] 4.3 Match `merged`/`closed`/`open` explicitly in `OriginPull::state` and map anything else to `PrState::Other`; verify with a dto test for an unknown state.

## 5. GitLab (items 24, 28)

- [x] 5.1 Pass `--hostname <ctx.repository.host>` on every `glab api` call through one argument builder; verify with an argv test.
- [x] 5.2 Set `truncated = true` on the returned files when the MR diff hits `MAX_DIFF_PAGES`; verify with an ops test using a mock `GitlabApi`.

## 6. Cleanup (items 58, 82 forge part)

- [x] 6.1 Remove the dead `GitlabApi::get_with_limit` default, the unreachable scheme strip in `normalize_credential_host`, and the no-op branch in `map_probe_error`; keep one `graphql_args` test; rename the three `normalize_host` functions after what each does; have the OAuth `get_with_limit` call `enforce_response_limit`. Verify with `cargo clippy -D warnings`.
- [x] 6.2 Fix the comments in `oauth/pkce.rs:15-18`, `provider_tokens.rs:14-17`, `forge/gitlab/mod.rs:8-14` and `auth_providers/sign_out.rs:22,71` (have `run_bounded` return the capture error so a timeout says "timed out").

## 7. Verify

- [x] 7.1 `(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test)`, `bunx tsc --noEmit`, `bun run test`, and `openspec validate harden-forge-providers --strict` all pass.
- [ ] 7.2 In `bun run tauri dev` on macOS: fetch a GitLab repo in `providerToken` mode ten times with no auth failure, and open a self-hosted ported remote's provider links. — manual
