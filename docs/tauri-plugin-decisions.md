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
| Store | Recommended for GL-26 non-secret app data only | Use for durable settings if the settings migration needs file-backed app data. Never store tokens, OAuth codes, refresh tokens, keychain handles, or provider credentials. Prefer Rust-owned storage when data influences native/provider behavior. |
| Stronghold | Deferred to GL-49 / GL-3 | Evaluate only for future native GitHub provider secret storage. If adopted, secret create/read/use must be Rust-side; do not expose a JS path that can retrieve token material. |
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

## Follow-up work

- GL-47: audit Tauri v2 plugins against this decision record.
- GL-48: define app-data and secret-storage rules for settings/native auth.
- GL-49: spike secure native credential storage for a future native GitHub provider.
- GL-50: evaluate deep-link and single-instance support for auth and app links.
- GL-51: keep the architecture rules linked to this allow/defer/avoid record.
