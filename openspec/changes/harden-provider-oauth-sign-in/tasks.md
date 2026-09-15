## 1. Rust impl — loopback state gate (`src-tauri/src/git/oauth/pkce/loopback.rs`, `oauth/mod.rs`)

- [x] 1.1 Add `expected_state: &str` to `wait_for_redirect` / `wait_for_redirect_with_connection_timeout`; declare a request terminal only when it carries `code` or `error` **and** a matching `state`; answer non-matching requests with the neutral page and keep looping. Update the doc comment. Verify `cargo check`.
- [x] 1.2 Pass `&state` from `run_pkce` and keep the existing post-wait state comparison; reword its comment to say the listener already enforces it. Verify `cargo test git::oauth`.
- [x] 1.3 Add `stray_terminal_request_without_state_is_ignored` beside `slow_connection_is_dropped_for_the_real_callback`: first client `GET /callback?error=denied`, second client `GET /callback?code=real-code&state=<expected>`; assert the returned redirect is the second. Verify it fails with 1.1 reverted and passes with it. If `loopback.rs` exceeds the Rust ceiling, move `mod tests` to `pkce/loopback/tests.rs`.
- [x] 1.4 Add a sibling test where the stray client sends a code with a wrong state and assert it is ignored too.

## 2. Rust impl — disjoint keychain locators (`oauth/`, `git/provider_tokens.rs`)

- [x] 2.1 Add `oauth_account_id(provider_id: &str) -> String` returning `oauth:<id>` plus a `OAUTH_LOCATOR_PREFIX` const, in a small `oauth/locator.rs` (or `identity.rs`), with a doc comment explaining the PAT collision. Verify `cargo check`.
- [x] 2.2 Use it in `run_sign_in_inner` for the `SecretKey` and for `ProviderOauthResult.account_id`. Verify `cargo test git::oauth`.
- [x] 2.3 In `save_provider_token_in`, reject an `account_id` starting with the reserved prefix with the existing "Enter the account username for this token." message. Verify `cargo test git::provider_tokens`.
- [x] 2.4 Add a `MemoryStore` test: PAT at `(gitlab, host, "42")`, OAuth persist with provider id `42` → PAT slot unchanged, OAuth token at the namespaced key. Verify `cargo test`.

## 3. Frontend test and type check (`src/store/`)

- [x] 3.1 Add a case to `src/store/providerToken.test.ts`: seed PAT metadata at `providerTokenKey(host, "42")`, mock `provider_oauth_sign_in` returning `accountId: "oauth:42"`, `transportUsername: "oauth2"`; assert the PAT row remains and `delete_provider_token` is never called with accountId `42`. Verify `bun run test src/store/providerToken.test.ts`.
- [x] 3.2 Confirm no frontend code parses or displays provider-token `accountId` (grep `accountId` under `src/store/accounts`, `src/lib/api/providers.ts`, `src/features/`); record the result in the PR description. Verify `bunx tsc --noEmit`.

## 4. Docs

- [x] 4.1 Update `docs/provider-oauth-setup.md` (storage section) to state that native-sign-in tokens are stored under a namespaced locator disjoint from pasted tokens, and that the loopback listener accepts only the callback carrying the sign-in's state. Verify the doc renders.
- [x] 4.2 Update the CLAUDE.md GitHub/multi-account paragraph if it names the locator shape (one clause at most). (Checked: it names only the non-secret `providerAccountId` locator, not its shape — no change.)

## 5. Definition of done

- [x] 5.1 `(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test git::oauth git::provider_tokens secrets)` passes.
- [x] 5.2 `bunx tsc --noEmit && bun run test && bun run build` pass.
- [x] 5.3 `bun run sizes` passes.
- [ ] 5.4 Manual (`bun run tauri dev`, dummy Bitbucket client id): start Bitbucket sign-in, `curl -s "http://127.0.0.1:<port>/callback?error=x"` from another shell — the app keeps waiting; then cancel. Do not complete authorization against a production client.
- [ ] 5.5 Manual: on a test GitLab host, save a PAT under login `42`, complete native sign-in, confirm both cards remain and the PAT card still authenticates.
