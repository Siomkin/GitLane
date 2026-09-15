## Context

See proposal.md — Why.

**Loopback.** `pkce::wait_for_redirect(listener, deadline, cancel)` (`src-tauri/src/git/oauth/pkce/loopback.rs`) accepts connections, parses `GET /callback?...`, computes `terminal = code.is_some() || error.is_some()`, writes the browser page, and returns on terminal. `run_pkce` (`oauth/mod.rs`) then compares `redirect.state` to the generated `state` and fails on mismatch; returning drops the `TcpListener`. Stray non-terminal probes (favicon) are already ignored. `state` and the PKCE verifier come from `getrandom` (`codes.rs`), so the only exposure is denial of the in-flight sign-in.

**Keychain locator.** `run_sign_in_inner` builds `SecretKey::new(provider, host, account.account_id)` from `identity::resolve_account` (GitLab `id.to_string()`, Bitbucket raw `uuid`) and `KeyringStore::set`s it; `SecretStore::set` replaces in place. `save_provider_token_in` (`git/provider_tokens.rs`) builds the same tuple with the typed login as `account_id`. The frontend keys OAuth *metadata* by `(host, transportUsername)` and PAT metadata by `(host, login)`, and passes `accountId` back opaquely for delete/status/bridge. Nothing in `src/` displays or parses `accountId` for provider tokens.

Engine: OAuth is the backend's `ureq` transport behind `HttpTransport`; keychain via `secrets.rs`. No libgit2/git CLI. IPC: `provider_oauth_sign_in` / `save_provider_token` / `delete_provider_token` keep their signatures and types — only the value of `accountId` returned by the OAuth flow changes shape, and every consumer treats it as opaque. Stores: `src/store/accounts/oauth.ts` unchanged in logic. Size: `loopback.rs` is ~465 lines including its in-file tests — already in the look band; moving `mod tests` to `pkce/loopback/tests.rs` is due if the new test does not fit under the ceiling.

## Goals / Non-Goals

**Goals:**
- The listener, not the orchestrator, decides what is terminal, and it decides on `state`.
- OAuth and PAT locators live in disjoint namespaces on the same host.
- Both properties are unit-tested without network or the real keychain.

**Non-Goals:**
- Peer authentication on loopback (impossible on `127.0.0.1`); the state value is the authenticator.
- Migrating existing raw-id OAuth keychain entries in place.

## Decisions

**D1 — `wait_for_redirect` takes `expected_state: &str` and matches before declaring terminal.**
`terminal = (code.is_some() || error.is_some()) && redirect.state.as_deref() == Some(expected_state)`. Non-matching requests get a neutral "this window can be closed" page (no hint about the expected value) and the loop continues. *Alternative:* keep the listener state-agnostic and have `run_pkce` re-enter the wait on mismatch. Rejected: the listener is dropped on return today, and re-entering means threading the listener back; it also leaves the doc comment ("drops when this returns") misleading. Deciding in the listener matches the comment already in `run_pkce`.

**D2 — Keep the orchestrator's state check.**
`run_pkce` still verifies `redirect.state == state` after the wait. Redundant by construction, cheap, and it keeps the existing tests meaningful.

**D3 — Namespace OAuth locators with a reserved prefix rather than an occupancy check.**
The keychain `account_id` for native sign-in becomes `oauth:<provider id>` via one helper (`oauth::locator::oauth_account_id(&str)`), used in `run_sign_in_inner`. `save_provider_token_in` rejects an `account_id` starting with `oauth:` ("Enter the account username for this token."). *Alternative:* `store.get(&key)` before `set` and refuse when occupied. Rejected: a re-sign-in of the same OAuth account is legitimate and must replace; an occupancy check cannot tell that apart from a PAT collision without also namespacing. *Alternative:* validate Bitbucket uuids as `{…}` and GitLab ids as numeric and reject PAT logins in those shapes. Rejected: GitLab does not forbid all-digit usernames, and the rule would be provider-specific and brittle.

**D4 — No frontend logic change; rely on existing compensation.**
`signInProviderOauth` already deletes the superseded OAuth token when `existing.accountId !== result.accountId`, which is exactly what happens on the first re-sign-in after this change (raw id → namespaced id). The `ProviderOauthResult.accountId` stays the value the frontend stores and echoes. A vitest pins that a PAT row at `(host, login)` is not deleted and its `delete_provider_token` is never invoked during an OAuth sign-in whose provider id equals that login.

**D5 — Tests.**
- `loopback.rs`: `stray_terminal_request_without_state_is_ignored` modelled on `slow_connection_is_dropped_for_the_real_callback` — a first client sends `GET /callback?error=denied`, a second sends `GET /callback?code=real&state=<expected>`; assert the returned `Redirect` is the second. Pre-fix it returns the first.
- `secrets.rs` / `provider_tokens.rs` with `MemoryStore`: set PAT `(gitlab, host, "42")`; run the OAuth persist step with provider id `42`; assert `get(pat_key)` still returns the PAT and `get(oauth_key)` returns the OAuth token.
- `provider_tokens.rs`: `save_provider_token_in` with login `oauth:x` returns the username error.
- `src/store/providerToken.test.ts`: seeded PAT metadata survives `signInProviderOauth` with a colliding `accountId`; `delete_provider_token` not called with the PAT's id.

## Risks / Trade-offs

- [A provider legitimately omits `state` on its error redirect] → RFC 6749 §4.1.2.1 requires `state` on error responses when the request carried one; Bitbucket complies. If a future PKCE provider does not, the user sees a timeout instead of the provider's error text — acceptable, and the log line names the mismatch.
- [Existing users' OAuth entries keyed by raw id] → Still reachable via saved metadata; replaced on next sign-in through the existing compensation path. No data loss; a note in the release notes.
- [Something in `src/` parses `accountId` for OAuth cards] → Grep at planning time found only opaque pass-through (`oauth.ts`, `providers.ts`, `accountBindings.ts` key composition). Task 3.3 re-checks with `bunx tsc` and the store tests.

## Migration Plan

- Ship in a normal release. No schema/version bump on persisted metadata.
- Rollback: reverting restores raw-id keys; tokens written under `oauth:` keys become unreachable until the user signs in again (their metadata still points at the namespaced id, so sign-out cleans up). Acceptable for a security fix; note in the release entry.
