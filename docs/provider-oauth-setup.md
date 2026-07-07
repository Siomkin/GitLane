# Native provider OAuth sign-in (GL-139)

GitLane can sign a user into **GitLab** and **Bitbucket** with native OAuth —
no personal access token to mint by hand, no CLI to install. On success the
resulting access token is stored in the OS keychain (the GL-132 `SecretStore`)
and fed to git via the `GIT_ASKPASS` credential bridge, so it authenticates
HTTPS git transport (clone/fetch/pull/push) without the token ever crossing the
IPC boundary.

Two flows, dispatched by provider:

- **GitLab** — OAuth 2.0 **Device Authorization Grant** (RFC 8628). GitLane shows
  a one-time user code, opens the verification page, and polls for the token.
- **Bitbucket** — **Authorization Code + PKCE** over a `127.0.0.1` loopback
  (RFC 8252), because Bitbucket Cloud has no device flow. GitLane opens the
  authorize page and captures the redirect on a transient local listener.

The PAT-into-keychain path and CLI detection remain as fallbacks and are
unchanged.

> **This feature needs a registered OAuth application (a public client id) per
> provider/host.** A public client id is *not* a secret — it only identifies the
> GitLane app during the flow; the device code / PKCE verifier are the actual
> proof. Until a client id is configured for a host, the OAuth button is hidden
> and GitLane points at the PAT fallback.

## 1. Register the OAuth applications

### GitLab (gitlab.com or self-managed)

Create an OAuth application (**User Settings → Applications**, or an
instance-wide application on self-managed GitLab):

- **Scopes:** `read_repository`, `write_repository`, `read_user`.
  - `read_repository` / `write_repository` authenticate git over HTTPS.
  - `read_user` lets GitLane resolve your account (the stable id + username) right
    after sign-in; it reads identity only.
- **Confidential:** **No** — this is a public/native client (no client secret is
  shipped). A confidential app makes GitLab reject the token exchange with
  `invalid_client`.
- **Device authorization grant:** **enable it** — GitLab's sign-in uses the OAuth
  2.0 Device Authorization Grant (RFC 8628), and GitLab leaves this off by default.
- **Redirect URI:** required by the form but unused by the device flow; any
  placeholder (e.g. `http://127.0.0.1/callback`) is fine.
- Copy the **Application ID** — that is the client id. A missing `read_user`
  scope surfaces as `invalid_scope`.

Self-managed GitLab: register one application per host and configure its client
id for that host (below).

### Bitbucket Cloud

Create an OAuth consumer (**Workspace settings → OAuth consumers → Add
consumer**):

- **Callback URL:** a loopback URL, e.g. `http://127.0.0.1/callback`. Bitbucket
  matches the callback host; GitLane binds an **ephemeral** loopback port per
  sign-in (RFC 8252). If your Bitbucket setup requires an exact port match,
  register a fixed one and open an issue — a configurable fixed port is a small
  follow-up.
- **Permissions:** **Account** (read) and **Repositories** (read *and* write).
- This is a public client using PKCE; no client secret is embedded.
- Copy the **Key** — that is the client id.

Bitbucket Server / Data Center (self-hosted) is a different product with a
different OAuth surface and is **not** supported by this flow; use a PAT there.

## 2. Configure the client id in GitLane

GitLane resolves a host's public client id in this order:

1. **Per-host override** — set in the app (persisted in Rust-owned app-data,
   `oauth-clients.json`; non-secret). Set it from:
   - **Settings → Accounts → (GitLab/Bitbucket) → Set a client id**, or
   - the repo's **Remotes** panel keychain row for that host.
2. **Compile-time built-in** — injected at build time via environment variables,
   for shipping an official GitLane app:

   ```bash
   GITLANE_GITLAB_OAUTH_CLIENT_ID=...    \
   GITLANE_BITBUCKET_OAUTH_CLIENT_ID=... \
     bun run tauri build
   ```

If neither resolves, native OAuth is unavailable for that host and GitLane shows
the PAT fallback.

## 3. Sign in

- **Settings → Accounts** → pick GitLab or Bitbucket → **Sign in with OAuth**
  (for the default public host), or
- the repo's **Remotes** panel → the remote's keychain row → **Sign in with
  OAuth** (binds *that* remote to the account on success).

Signing in for a specific remote pins the account into the remote's HTTPS URL
username so fetch/push immediately use the keychain token.

## How the token authenticates git

An OAuth **access token** authenticates git HTTPS as a fixed sentinel username,
not your handle:

| Provider  | Git username   | Password       |
| --------- | -------------- | -------------- |
| GitLab    | `oauth2`       | access token   |
| Bitbucket | `x-token-auth` | access token   |

So an OAuth account carries a **transport username** (the sentinel, pinned into
the remote URL and answered by the bridge) distinct from its **display login**
(your real handle). The keychain entry is keyed by the provider's stable account
id, so multiple hosts and accounts stay isolated.

## Known limitations

- **Access-token lifetime.** GitLab and Bitbucket OAuth access tokens are
  short-lived (on the order of a couple of hours). When one expires, git auth
  fails and you re-run **Sign in with OAuth**. Refresh-token rotation (staying
  signed in across expiry) is deliberately out of scope for GL-139 and tracked as
  follow-up. For a long-lived credential today, use the PAT path.
- **One OAuth account per host.** Because both GitLab OAuth accounts on one host
  share the `oauth2` git username, a second OAuth account on the *same host* would
  need an explicit per-remote binding to disambiguate. Multiple **hosts**, and
  multiple PAT accounts, work today.
- **Bitbucket Cloud only** for native OAuth; **HTTPS only** (the keychain bridge
  is scoped to `https://` remotes, per GL-132).
- **PR/MR features stay GitHub-only.** OAuth sign-in enables git transport;
  GitLab/Bitbucket merge-request surfaces are still not implemented.

## Security notes

- The access token, device code, PKCE verifier, and authorization code never
  cross IPC, never enter logs, and never reach the frontend. Only non-secret
  account metadata and display-safe progress milestones do.
- Cancelling a sign-in stops polling / drops the loopback listener, discarding the
  codes.
- All surfaced `git`/OAuth errors are passed through the redactor
  (`src-tauri/src/redact.rs`).
- The single outbound-HTTP dependency (`ureq`, rustls) is confined to
  `src-tauri/src/git/oauth/http.rs` behind an `HttpTransport` trait; it runs in
  the Rust process, so no CSP `connect-src` entry is involved.

## Related

- `docs/provider-auth-qa-matrix.md` — the verification checklist (device/PKCE
  rows).
- `docs/tauri-plugin-decisions.md` — the `ureq` dependency decision and the
  client-id app-data entry in the persistence inventory.
- GL-132 — the keychain `SecretStore` + `GIT_ASKPASS` bridge this builds on.
