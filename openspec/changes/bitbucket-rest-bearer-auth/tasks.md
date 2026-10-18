# Tasks

## 1. Rust: Bearer-only Bitbucket REST client

- [x] 1.1 In `src-tauri/src/git/forge/bitbucket/transport.rs`, make `auth_header` return `Bearer {token}` unconditionally, drop the `username` parameter from `RestClient::new` (signature `new(http, host, token)`, matching `gitlab/transport.rs`), set `extra_secrets: &[]`, and remove `OAUTH_USERNAME` and the now-unused `base64` import in this file. Verify with `(cd src-tauri && cargo check)`
- [x] 1.2 In `src-tauri/src/git/forge/bitbucket/mod.rs`, make `credential()` return only the token and `with_api` call `RestClient::new(&http, &ctx.repository.host, &token)`. Verify `cargo check` passes and no `account.login` read remains in the REST path
- [x] 1.3 Update the module docs in `bitbucket/mod.rs` and `bitbucket/transport.rs` to say REST always uses Bearer and the git HTTPS username matters only for git transport. In `src-tauri/src/git/forge/rest.rs`, reword the module doc and the `extra_secrets` field doc so they no longer cite Bitbucket's Basic payload; keep the field. Verify `grep -n "Basic" src-tauri/src/git/forge/bitbucket/*.rs src-tauri/src/git/forge/rest.rs` returns nothing
- [x] 1.4 In `bitbucket/transport/tests.rs`, replace `oauth_username_uses_bearer_others_use_basic` with one test asserting the client sends `Bearer tok`. Delete `auth_header_encodes_the_padded_basic_payload` and `basic_errors_redact_token_and_payload_end_to_end`, and convert `get_text_errors_redact_basic_credentials` to a Bearer version (the shared suite does not cover `get_text` error redaction); `bearer_rest_errors_are_redacted_including_the_scope_403_auth_hint` already covers JSON-path Bearer redaction, and `rest/tests.rs` keeps `extra_secrets` and URL redaction covered. Update all 29 `RestClient::new(.., username, ..)` calls (9 in `transport/tests.rs`, 20 in `ops/tests/*.rs`) to the three-argument form. Verify `(cd src-tauri && cargo test forge::bitbucket)` and `(cd src-tauri && cargo test forge::rest)` pass

## 2. Rust: distinct rejected-token error

- [x] 2.1 Add `bitbucket_token_rejected(host)` next to `no_bitbucket_auth` in `bitbucket/mod.rs`: a `GithubError::NotAuthenticated` whose hint says Bitbucket rejected the saved token (it may be expired, revoked or an app password), and to create an API token with scopes and save it in Settings → Accounts on the Bitbucket remote's credential with "Try this token for pull requests too" checked. Point the `map_http_error` 401 arm in `transport.rs` at it, and leave `no_bitbucket_auth` for the no-account and keychain-miss paths. Verify `cargo check`
- [x] 2.2 Add a unit test for `bitbucket_token_rejected` asserting it contains "rejected", "API token" and "Settings", the host, and no "gh auth". Extend `maps_http_status_to_categories` to assert the 401 text is not the "No Bitbucket PR sign-in found" text and still maps to `CommandErrorKind::Auth`. Leave `no_bitbucket_auth_names_git_transport_fallbacks_not_gh` unchanged, so the no-sign-in message still must not mention API tokens. Verify `(cd src-tauri && cargo test forge::bitbucket)` passes

## 3. Frontend comments and test titles

- [x] 3.1 Correct the comments in `src/store/accounts/transportAuth.ts` (the `prAccountRef()` Bitbucket branch, and the `tokenRef` comment) and in `src/lib/forgeHelp.ts` `defaultTransportUsername` to say Bitbucket PR REST calls always use Bearer and the HTTPS username matters for git only. No code change. Verify `bunx tsc --noEmit` passes
- [x] 3.2 In `src/store/providerToken.test.ts`, retitle the two `prAccountRef` tests that end "→ backend uses Bearer" and "→ backend uses Basic (API token)", so they describe the ref only (the backend uses Bearer for both). Keep their assertions. Verify `bun run test src/store/providerToken.test.ts` passes

## 4. Rust: keep the token on same-host redirects

- [x] 4.1 In `src-tauri/src/git/oauth/http/ureq_client.rs`, add `.redirect_auth_headers(ureq::config::RedirectAuthHeaders::SameHost)` to the agent built in `UreqTransport::new`, with a one-line comment on why (Bitbucket serves PR diff/diffstat through a same-host redirect). Add a unit test asserting `UreqTransport::new().agent.config().redirect_auth_headers() == RedirectAuthHeaders::SameHost`. Verify `(cd src-tauri && cargo test oauth::http)` passes
- [x] 4.2 Remove the temporary `GL-TRACE` debug lines added during the in-app investigation (`commands/github.rs`, `commands/auth.rs`, `bitbucket/mod.rs`, `bitbucket/transport.rs`). Verify `grep -rn GL-TRACE src-tauri/src` returns nothing

## 5. Definition of done

- [x] 5.1 Run the Rust gates and verify they all pass: `(cd src-tauri && cargo fmt --all -- --check)`, `(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)`, `(cd src-tauri && cargo test)`
- [x] 5.2 Run the frontend and ratchet gates and verify they all pass: `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run sizes`
- [x] 5.3 Manual check in `bun run tauri dev` on a `bitbucket.org` repo with a scoped API token saved under the Bitbucket username: the PRs tab lists pull requests and a selected pull request shows its diff. Then save an invalid token and verify the PRs tab shows the rejected-token message, not "No Bitbucket PR sign-in found"
