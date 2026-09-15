## Why

Native provider sign-in (GL-139: GitLab device flow, Bitbucket PKCE loopback) stores the resulting access token in GitLane's keychain namespace. Security audit run-2 traced two source-grounded leads in that path, both `needs_validation` only because the run executed no code:

- `oauth/pkce/loopback:terminal-before-state-check` — the transient `127.0.0.1` listener treats *any* request carrying `code=` or `error=` as the terminal redirect and returns it; only then does the orchestrator compare `state`. On mismatch the flow fails and the listener is dropped, so the real browser redirect can never land. Any local process — another OS user, a sandboxed app — can abort a Bitbucket sign-in during its 600 s window with one `GET /callback?error=x`, repeatably, forcing the user onto a pasted PAT. The comment in `run_pkce` states the opposite invariant; the listener never received the state to enforce it. Hijack is already prevented (random `state`, S256 PKCE); this is denial of sign-in.
- `oauth/identity/whoami-account-id-overwrites-same-host-keychain-slot` — the OAuth token is stored under `(provider, host, account_id)` where `account_id` is copied from the provider's user API (GitLab numeric id, Bitbucket uuid). A pasted PAT is stored under the same tuple with the typed login as `account_id`, and the keychain store replaces in place with no occupancy check. A PAT saved as login `42` on a GitLab host and a subsequent OAuth sign-in whose whoami returns `id: 42` share one keychain slot: the PAT secret is silently replaced, the PAT card still shows, and signing out either card deletes the other's token. The webview compensation only inspects the OAuth sentinel key, so it never notices.

Jira: no issue exists yet (create a `GL-xx` Task before implementation and put the key in the branch name).

## What Changes

- The PKCE loopback listener receives the expected `state` and treats a request as the terminal redirect **only** when its `state` matches. A `code=`/`error=` request with a missing or different `state` is answered with a neutral page and ignored; the listener keeps waiting for the real redirect until the deadline or cancel. The orchestrator's post-hoc state check stays as defence in depth.
- OAuth-captured tokens are stored under a locator that cannot collide with a pasted-PAT locator on the same host: the keychain `account_id` for a native sign-in is namespaced (`oauth:<provider id>`), and `save_provider_token` refuses a login that begins with that reserved prefix. The locator stays opaque to the frontend, which already passes `accountId` through unchanged for delete, status, and the transport bridge.
- Existing OAuth entries stored under the raw provider id remain reachable through their saved metadata; a re-sign-in writes the namespaced key and the existing superseded-token cleanup in `signInProviderOauth` deletes the old one.
- Regression tests: a loopback test where a stray `error=` request precedes the real `code=&state=` callback; a `MemoryStore` test proving a PAT slot survives an OAuth sign-in with a colliding provider id; a vitest asserting the PAT metadata row is untouched.

Rust (`src-tauri/src/git/oauth/`, `git/provider_tokens.rs`) plus a frontend test. No IPC command signature changes: `provider_oauth_sign_in` returns the same `ProviderOauthResult` shape (the `accountId` value is now namespaced).

## Capabilities

### New Capabilities
- `accounts/transport`: what GitLane guarantees about capturing and storing a provider credential for a host — a native sign-in cannot be aborted by an unauthenticated local peer, and a stored credential is never replaced or orphaned by a sign-in for a different account card.

### Modified Capabilities
_None._ There is no existing `accounts/*` spec; this change introduces the capability with the requirements native sign-in has been meant to uphold.

## Non-goals

- No change to the device flow (GitLab) beyond sharing the same storage rule; it binds no listener.
- No change to which providers support native OAuth, to scopes, to the client-id resolution, or to the sentinel transport usernames (`oauth2`, `x-token-auth`).
- No migration of already-stored raw-id OAuth entries in place (they keep working; they are cleaned up on the next sign-in for that host).
- No new IPC command and no new place a secret crosses IPC; `save_provider_token` remains the only PAT entry point.

## Impact

- `src-tauri/src/git/oauth/pkce/loopback.rs` — `wait_for_redirect` gains the expected state; terminal decision changes.
- `src-tauri/src/git/oauth/mod.rs` — `run_pkce` passes the state; `run_sign_in_inner` builds the namespaced key.
- `src-tauri/src/git/oauth/identity.rs` or a small `locator` helper — the `oauth:` namespace in one place.
- `src-tauri/src/git/provider_tokens.rs` — `save_provider_token_in` rejects the reserved prefix.
- `src/store/accounts/oauth.ts` — no logic change expected; a test is added in `src/store/providerToken.test.ts`.
- Secrets/auth/IPC risk: reduced. The token still never crosses IPC; only the non-secret locator changes shape. The two secret-carrying commands are unchanged.
- Pattern to copy: `slow_connection_is_dropped_for_the_real_callback` for the loopback test; the `MemoryStore` tests in `secrets.rs`; `providerToken.test.ts` for the store test.
