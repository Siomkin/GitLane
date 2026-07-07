# Tauri plugin decision record

Jira: GL-46

This record audits Tauri v2 plugins against GitLane's architecture. It is not a
catalog mirror; it is the local allow/defer/avoid decision for dependencies that
affect native capabilities, storage, subprocesses, and secrets.

Sources checked:

- Current inventory: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`,
  `src-tauri/capabilities/default.json`, `src-tauri/tauri.conf.json`.
- Official Tauri v2 plugin docs: https://v2.tauri.app/plugin/
- Related GitLane roadmap: `docs/github-provider-auth-roadmap.md`.

## Current inventory

GitLane currently installs only the plugins needed by existing product behavior:

| Plugin | Rust crate | JS package | Registration/config site | Capability | Why it is installed |
| --- | --- | --- | --- | --- | --- |
| Dialog | `tauri-plugin-dialog` | `@tauri-apps/plugin-dialog` | `src-tauri/src/lib.rs` builder plugin | `dialog:default` | Native repo/file selection and confirmation surfaces. |
| Opener | `tauri-plugin-opener` | `@tauri-apps/plugin-opener` | `src-tauri/src/lib.rs` builder plugin | `opener:default` | Open external links/files through the OS without the broader shell plugin. |
| Window State | `tauri-plugin-window-state` | none | `src-tauri/src/lib.rs` builder plugin | `window-state:default` | Persist main window size and position across launches. |
| Updater | `tauri-plugin-updater` | `@tauri-apps/plugin-updater` | `src-tauri/src/lib.rs` setup hook; `src-tauri/tauri.conf.json` endpoints/signing key | `updater:default` | GL-24 in-app update flow backed by signed GitHub Release artifacts. |
| Process | `tauri-plugin-process` | `@tauri-apps/plugin-process` | `src-tauri/src/lib.rs` builder plugin | `process:allow-restart` | Relaunch after an update install. Exit is intentionally not granted. |

`src-tauri/capabilities/default.json` is the capability inventory of record.
Adding a plugin is not complete until its permissions are added narrowly there
and the reason is documented in this file.

## Non-negotiable rules

- Secrets stay out of IPC, Zustand, localStorage, Tauri Store JSON, logs, crash
  output, and frontend-accessible plugin state.
- Git and GitHub operations keep the current split: reads use libgit2 where
  appropriate, writes shell out to `git`, and GitHub goes through
  `GithubService`/`GhProvider`/`gh` until the native-provider roadmap says
  otherwise.
- Do not add a plugin just because it exists in the Tauri catalog. Add it only
  for a concrete GitLane workflow, with scoped capabilities and a ticket.
- Frontend plugin APIs are not a shortcut around the IPC contract. Repo state,
  credentials, subprocesses, filesystem access, and provider logic belong behind
  typed Rust commands and `src/lib/api/*` wrappers.

## Decisions

| Plugin | Decision | GitLane guidance |
| --- | --- | --- |
| Dialog | Installed | Keep. Use for native picker/message UX. Do not use it to bypass typed repo commands. |
| Opener | Installed | Keep. This is the preferred way to open external URLs/files from the frontend. |
| Window State | Installed | Keep. Scope remains window geometry/state only. |
| Updater | Installed | Keep under GL-24. Updates must remain signed and configured in `tauri.conf.json`. |
| Process | Installed | Keep only `process:allow-restart` for updater relaunch. Do not grant `allow-exit` without a product need. |
| Store | Deferred — prefer Rust-owned app-data | Not currently needed: terminal agents already use Rust-owned app-data (`terminal_agents.rs`), the preferred home for durable non-secret app metadata (see the persistence inventory below). Adopt the Store plugin only if a settings migration genuinely needs frontend-written, file-backed storage. Never store tokens, OAuth codes, refresh tokens, keychain handles, or provider credentials. |
| Stronghold | Not adopted — superseded by the `keyring` crate (GL-132) | We evaluated secure-storage options for GitLane-owned provider tokens and chose the `keyring` crate over the Stronghold plugin: it targets the OS-native keychain directly (macOS Security.framework, Windows Credential Manager, Linux Secret Service), is Rust-only with no JS surface, and needs no encrypted vault file to manage. See "Secret-storage posture" below. Revisit Stronghold only if a portable app-managed vault is ever needed. |
| `keyring` crate (not a Tauri plugin) | Installed (GL-132) | Backend-only OS-keychain access for GitLane-owned provider transport tokens (`src-tauri/src/secrets.rs`). Platform-native features only (`apple-native` / `windows-native` / `sync-secret-service`) — no JS package, no capability/permission, no CSP change. Secrets are written/read solely in Rust and reach git via the `GIT_ASKPASS` credential bridge (`src-tauri/src/git/credential_bridge.rs`); they never cross IPC. macOS access to the app's own generic-password items needs no entitlement; an unsigned dev build may prompt once on first read. |
| `ureq` + `sha2` + `getrandom` crates (not Tauri plugins) | Installed (GL-139) | The backend's **first outbound-HTTP dependency**, for native provider OAuth (GitLab device flow / Bitbucket PKCE). Confined to `src-tauri/src/git/oauth/http.rs` behind an `HttpTransport` trait so the flow state machines unit-test against a mock. `ureq` is blocking (fits the existing `blocking()` subprocess pattern) with `default-features = false` + rustls (no system-TLS link); `sha2`/`getrandom` back the PKCE challenge and CSRF state. **No CSP change** — this HTTP runs in the Rust process, not the webview (`connect-src` governs only the webview). No JS package, no capability/permission. The Bitbucket flow also binds a transient `127.0.0.1` loopback `TcpListener` to receive the OAuth redirect (dropped on completion/cancel). Tokens/codes/verifiers never cross IPC. |
| Deep Link | Deferred to GL-50 | Add only when auth callbacks or app links have a concrete flow. Desktop schemes must be configured deliberately; do not reserve schemes speculatively. |
| Single Instance | Deferred with Deep Link | Add with deep-link work if duplicate app launches would lose auth/app-link events. Register it before deep-link handling, per Tauri's desktop guidance. |
| Shell | Avoid | GitLane already shells out from Rust through audited helpers (`run_git`, `run_git_env`, `run_gh`) and PTY code. Do not expose generic frontend process spawning. Use Opener for external URLs. |
| File System | Avoid for frontend; Rust-only by default | Existing Rust commands use `std::fs`/repo path validation where needed. Do not expose broad frontend filesystem APIs for repo files, conflicts, settings, or secrets. |
| Clipboard | Deferred | Add only for explicit native clipboard workflows that cannot use browser clipboard APIs reliably. Never copy secrets automatically. |
| Log | Deferred | Useful for structured diagnostics later, but only with redaction rules first. Logs must not include tokens, OAuth codes, remote auth headers, repo-local secret files, or raw command environments. |
| OS Information | Deferred | Add only for product-visible platform behavior that cannot be resolved at build time or in Rust. Do not expose hostname by default. |
| Notification | Deferred | Add only for long-running background operations with user-visible completion/failure UX. Notification bodies must not include secrets or private repo content by default. |
| Autostart | Avoid for now | A git client should not launch at login unless there is an explicit user setting and background value proposition. |
| FS persisted scope | Avoid until FS is justified | Persisted filesystem scopes are unnecessary while frontend FS access is avoided. Revisit only with a concrete scoped FS plugin use case. |

## Checklist for adding a plugin

Use this checklist for any future Tauri plugin change:

1. Create or reference a GL ticket that states the product workflow and why a
   native plugin is required.
2. Update Rust dependencies in `src-tauri/Cargo.toml` and JS dependencies in
   `package.json` only when the frontend API is actually needed.
3. Register the plugin in `src-tauri/src/lib.rs`; desktop-only plugins belong
   behind the same style of platform gate as the updater.
4. Add only the required permissions to `src-tauri/capabilities/default.json`.
   Avoid broad defaults when a narrower permission exists.
5. Update `src-tauri/tauri.conf.json` or CSP only when the plugin needs explicit
   config, endpoints, schemes, or external origins.
6. Route domain behavior through typed Rust commands, `src/lib/api/*`, and the
   owning store/hook. Do not call frontend plugin APIs from feature components
   for repo state, credentials, subprocesses, or filesystem access.
7. Add the cheapest useful verification: typecheck/build for code changes,
   targeted tests for logic, and a manual app check for IPC or platform behavior.
8. Update this decision record with the new installed/deferred/avoid decision
   and rationale.

## Persistence inventory and data classification

This table is the inventory of record for what GitLane persists, where, and why —
and the rule for placing **new** data. It pairs with the non-negotiable secret rule
above and the secret-storage posture below.

Categories: **UI preference** (view chrome, no privacy impact), **app metadata**
(non-secret app config/state), **repo metadata** (data about the open repo or its
identity), **account refs** (frontend-safe provider bindings, never tokens), and
**secret** (token/credential material — never persisted by GitLane).

| Stored item | Location | Category | Contents | Sensitivity |
| --- | --- | --- | --- | --- |
| `gitlane.ui` | `localStorage` (Zustand persist) | UI preference | theme/accent, density, panel widths, collapsed groups, PR filter/tab | none |
| `gitlane.openPaths`, `gitlane.lastPath` | `localStorage` | repo metadata | absolute paths of opened repos + last repo | low — reveals local filesystem paths on a shared machine |
| `gitlane.repoAccounts` | `localStorage` | account refs | per-repo `{ provider, host, accountId, login }` | low — metadata only, no token |
| `gitlane.repoIdentity` | `localStorage` | repo metadata | cached commit identity (name/email), reconciled against repo-local git config | low — git config is the source of truth; this is a cache |
| `terminal-agents.json` | Tauri app-data dir (Rust-owned) | app metadata | terminal agent command definitions | none |
| `oauth-clients.json` | Tauri app-data dir (Rust-owned) | app metadata | per-host **public** OAuth client ids (GL-139 override) | none — a client id is a public identifier, not a secret |
| repo-local `.git/config` | repo, via `set_repo_identity` | repo metadata | `user.name` / `user.email` / signing | low — git is the source of truth, not a GitLane store |
| window geometry | `tauri-plugin-window-state` | UI preference | main window size/position | none |
| GitHub token / SSO | `gh`-owned (keyring/config) | secret | tokens, refresh/SSO state | **secret — never persisted by GitLane; resolved server-side per operation** |

### Where new data goes

- **UI-only preference** (no privacy or native-behavior impact): `localStorage` via
  the `gitlane.ui` Zustand store is fine.
- **App metadata** that must be durable, file-backed, or that influences
  native/provider behavior: Rust-owned app-data, following `terminal_agents.rs`.
  This is preferred over `localStorage` and over adding the Store plugin. A
  telemetry `installId` and a telemetry enabled/disabled flag, if such a feature is
  ever built, belong here — and disabling telemetry must stop heartbeat requests
  **without** regenerating the `installId`.
- **Repo metadata / account refs**: keep frontend-safe — no token, no machine
  fingerprint. `localStorage` is acceptable; migrate to Rust app-data only if a
  concrete privacy requirement appears (e.g. hiding opened repo paths on shared
  machines).
- **Secrets**: never in `localStorage`, Zustand, IPC payloads, app-data JSON, logs,
  or serialized Tauri window/app state. Native credentials, if GitLane ever owns
  them, must be Rust-side in an OS-secure backend (evaluated under GL-49) and must
  not cross IPC — only derived status does. See the secret-storage posture below.

## Secret-storage posture

Current GitLane behavior should remain the default:

- `gh` owns GitHub tokens and SSO state.
- GitLane persists only frontend-safe account refs: provider, host, account id,
  and login.
- Rust resolves tokens immediately before a GitHub operation and passes them to
  child processes through environment variables only for that operation.

Future native-provider work may introduce GitLane-owned secrets, but the storage
rule is stricter than "use a plugin":

1. Decide the native provider contract first (`docs/github-provider-auth-roadmap.md`).
2. Store secrets in a Rust-owned secure backend, evaluated under GL-49.
3. Return only derived status to the frontend: configured, missing, expired,
   needs reauth, or permission failure.
4. Keep token material, refresh tokens, OAuth device codes, and recovery data out
   of JS-visible APIs and persistent JSON stores.

### GL-132 — GitLane-owned provider transport tokens

The foundation for provider auth parity (GL-131 epic) makes GitLane a secret
*owner* for provider accounts it authenticates itself (e.g. a GitLab/Bitbucket
PAT captured in-app), while `gh` remains the GitHub owner. It follows the rule
above:

- **Storage** — the OS keychain via the `keyring` crate, in a GitLane-namespaced
  service (`space.gitlane.provider-token`), keyed by `(provider, host, account
  id)`. Code: `src-tauri/src/secrets.rs` (`SecretStore` trait + `KeyringStore`).
- **Use** — a git network op under `providerToken` transport auth points git at
  this binary as its `GIT_ASKPASS` helper; the helper reads the token from the
  keychain in a short-lived child process and answers git's prompt. The token
  lives only in the git↔helper process pair. Code:
  `src-tauri/src/git/credential_bridge.rs`.
- **IPC** — only non-secret handles cross the boundary: the transport ref carries
  a `providerAccountId` locator, and `save_provider_token` receives a token once
  (like `approve_https_credential`) but returns only a `ProviderTokenStatus`
  (`hasToken` presence, never the value).
- **Two distinct verbs** — provider **sign-out** (`delete_provider_token`)
  removes GitLane's own keychain secret; **forget saved HTTPS credential**
  (`reject_https_credential` → `git credential reject`) erases what the user's own
  Git credential helper stored. Neither touches the other's store.
- **Redaction** — surfaced `git`/`gh` errors are scrubbed of URL-embedded
  credentials (`src-tauri/src/redact.rs`) before crossing IPC.

### GL-139 — native provider OAuth sign-in

Builds directly on GL-132: a native OAuth sign-in (GitLab device flow / Bitbucket
PKCE loopback, `src-tauri/src/git/oauth/`) ends by writing the access token into
the *same* keychain via the *same* bridge, so nothing about the storage/use/IPC
posture changes — the token authenticates git without crossing IPC. New surface:

- **Outbound HTTP** — `ureq` (rustls) confined to `oauth/http.rs` behind an
  `HttpTransport` trait; the OAuth secrets (access token, device code, PKCE
  verifier, authorization code) live only inside the module and are never logged,
  returned, or emitted. Redaction wraps every surfaced error.
- **Public client id** — resolved from a compile-time `option_env!` built-in
  overridden by a per-host value in Rust-owned app-data (`oauth-clients.json`).
  Public, not a secret; stored in cleartext by design and **never** in the keychain
  (that is reserved for the token).
- **Loopback** — the Bitbucket PKCE flow binds a transient `127.0.0.1` listener for
  the redirect; it is dropped on completion/cancel. No deep-link scheme is reserved
  (Deep Link stays deferred, GL-50).

## Content Security Policy

`app.security.csp` in `src-tauri/tauri.conf.json` is an explicit allowlist rather
than the previous image-only directive:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: asset: https://asset.localhost https://*.githubusercontent.com;
font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost;
object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'
```

Rationale:

- This is defense-in-depth, not a fix for a live sink. Markdown HTML is already
  sanitized (`rehype-sanitize`) and external navigation is centralized in
  `src/lib/openExternal.ts`; the CSP is the browser-enforced backstop if a future
  change introduces an injection sink.
- `script-src 'self'`: the production bundle emits only an external module script;
  there are no inline `<script>` tags. Tauri appends its own nonce/hash for the
  injected IPC bootstrap at compile time, so no `'unsafe-inline'` is needed.
- `style-src 'self' 'unsafe-inline'`: required for runtime inline `style={}`
  attributes. Safe here because the bundle has no inline `<style>` tags for Tauri
  to nonce (a nonce would otherwise nullify `'unsafe-inline'`).
- `connect-src 'self' ipc: http://ipc.localhost`: the IPC bridge endpoints Tauri
  needs. `img-src` keeps the existing markdown image policy (GitHub user-content +
  `data:`/`asset:`).
- `object-src/base-uri/frame-ancestors/form-action` are locked down because the
  app uses none of them.

Pending verification (defense-in-depth, not blocking): confirm the effective
policy in a packaged build / `tauri dev` via Web Inspector — Tauri may transform
the CSP at build time. If inline `style={}` attributes are refused in a packaged
build, the documented mitigation is adding `style-src-attr 'unsafe-inline'`.

## IPC boundary validation (GL-57)

The `lib/api/*` wrappers historically blind-cast `invoke<T>(...) as T` with no
runtime check, so a serde-struct ↔ TS-interface drift (a renamed field, a new
nullable, a changed shape) compiled clean on both sides and failed only at runtime
in front of a user. GL-55's audit flagged this as the single load-bearing risk in
the architecture.

**Decision: approach A — runtime schema validation at the seam — using `zod`.**

- **New dependency:** `zod` (runtime `dependencies`). It is a pure-TS validation
  library: no native capability, no Tauri plugin, no storage, no subprocess, and it
  never touches secrets — so it sits outside the native-plugin allow/defer/avoid
  matrix above, but is recorded here because every JS dependency is logged in this
  file (see `CLAUDE.md`).
- **What it does:** `lib/api/schemas.ts` holds zod schemas for the high-traffic /
  highest-risk responses, and `lib/api/validate.ts` parses each `invoke` result
  through its schema, throwing a named `IpcValidationError` (command + offending
  field paths) at the boundary instead of letting an `undefined` access crash a
  component deep in the tree. These errors are contained by the feature error
  boundaries from GL-56.
- **Covered commands:** `commit_graph`, `working_changes`, `file_diff` (plus the
  `commit_file_diff` / `diff_range_file` / `selection_diff_file` /
  `compare_file_diff` variants that share the `FileDiff` shape), and every GitHub
  read: `pull_request_detail`, `github_accounts`, `list_pull_requests`,
  `pull_request_checks`, `pull_request_commits`, `pull_request_diff`,
  and `pull_request_review_threads` (GL-122 follow-up). GitHub write commands
  return gh's plain string output and are not schema-validated. Extend coverage
  to a new command by adding its schema and parsing the result in the wrapper.
- **Type source of truth:** the hand-written, documented interfaces in `git.ts` /
  `github.ts` stay the *type* source of truth (their field docs are valuable); the
  schema is the *runtime* source of truth. A compile-time `assertEqual` guard in
  `schemas.ts` fails the build if the two diverge, so a field added to one must be
  added to the other.

**Why not approach B (codegen TS from Rust via `ts-rs`/`specta`):** B removes the
TS↔Rust drift at the source but adds Rust derive macros across `git/types.rs` plus a
generation step in the build, and — crucially — does **not** validate the runtime
payload shape, which is the actual user-facing failure mode here. A is self-contained
on the TS side, directly testable in the existing vitest harness, and pairs with the
GL-56 boundaries. B stays a complementary future option (B closes drift at compile
time; A guards the runtime shape); it is not required now.

## Follow-up work

- GL-47: audit Tauri v2 plugins against this decision record.
- GL-48: define app-data and secret-storage rules for settings/native auth —
  addressed by the persistence inventory and classification table above.
- GL-49: spike secure native credential storage for a future native GitHub provider.
- GL-50: evaluate deep-link and single-instance support for auth and app links.
- GL-51: keep the architecture rules linked to this allow/defer/avoid record.
- GL-57: validate the IPC boundary at the `lib/api` seam (zod, approach A) — done;
  Rust→TS codegen (ts-rs/specta) remains an optional compile-time complement.
