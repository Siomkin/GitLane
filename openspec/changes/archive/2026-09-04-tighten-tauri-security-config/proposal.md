## Why

The Tauri configuration is narrow and mostly right (`withGlobalTauri` unset, no shell/fs/http plugin, capabilities scoped to one window with a small explicit list, updater signature key pinned), but four things are wider or weaker than the code needs: the CSP names sources nothing uses, the sanitiser and the CSP disagree about which image hosts PR markdown may load, macOS release builds are ad-hoc signed and not notarised, and two OS-open helpers pass user paths without an argument terminator. This change records the security invariants the app already relies on and closes those gaps.

No Jira key (GL-xx) for this change. Touches Rust (`shell.rs`, `git/write/reveal.rs`), config (`src-tauri/tauri.conf.json`, `capabilities/default.json`), CI (`release.yml`), and the frontend (`Markdown.tsx`). No IPC signature change.

## What Changes

- **CSP** (`src-tauri/tauri.conf.json` `app.security.csp`):
  - `img-src … asset: https://asset.localhost` — no `app.security.assetProtocol` is configured and there are zero `convertFileSrc`/`asset://` uses in `src/`, so both entries are dead. Remove.
  - `img-src https://*.githubusercontent.com` — the markdown sanitiser (`src/components/ui/Markdown.tsx:34,63`) allows `http`, `https`, and `data` image sources and special-cases `img.shields.io` badges (`Markdown.tsx:48`), while the CSP allows only GitHub user content. Whether shields badges currently render as `<img>` or fall back to text is **not verified**; either way the two lists must be one list.
  - `style-src 'self' 'unsafe-inline'` — 127 `style={…}` React attributes need inline *attribute* styles; `'unsafe-inline'` also permits injected `<style>` elements. Tightening to `style-src 'self'; style-src-attr 'unsafe-inline'` is proposed; WebKit support on the shipped macOS floor is **not verified** and is a task.
  - `connect-src 'self' ipc: http://ipc.localhost`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'none'` — correct, keep.
- **Capabilities** (`src-tauri/capabilities/default.json`): every permission has a JS call site (`AboutPanel.tsx:60-61`, `WindowControls.tsx`, `WindowResizeHandles.tsx:67`, three `data-tauri-drag-region` uses, `openExternal.ts:8`, three `plugin-dialog` imports, `lib/updater.ts:7`). `opener:allow-open-url` allows `http://*`, matching the frontend gate (`src/lib/openExternal.ts:13`). No change except documenting the list as intentional.
- **Signing / updater**: `bundle.macOS.signingIdentity: "-"` (ad-hoc) and `release.yml:467-478` states Apple signing and notarisation are "intentionally NOT wired". Updater artifacts are minisign-signed (pubkey in `tauri.conf.json`; preflight refuses to run without the private key, `release.yml:171-186`), and `updater::check_update_on_channel` (`src-tauri/src/updater.rs:73-86`) overrides only endpoints so the pubkey stays in force on both channels. Proposed: Developer ID signing + notarisation on the release job, guarded by secret presence.
- **Input hardening (regression guard, not a live bug)**: `shell::reveal` (`src-tauri/src/shell.rs:201-215`), `git/write/reveal.rs`, and `git/write/open_path.rs` pass the path as a positional argument to `open -R`, `explorer /select,`, `xdg-open`. Today every path that reaches them is absolute (`reveal.rs:22,45` resolves `workdir.join(file)`; `reveal_path` receives the normalised `summary.path`), so a leading `-` cannot be read as an option. Nothing asserts that, so a future caller passing a relative name would regress silently. Add an absolute-path assertion at each opener (whether macOS `open` honours `--` is not verified, so do not rely on it).
- **Verified, no change**: worktree path guards (`git/write/path_guards.rs:65-122` rejects `..` and `.git` components; `git/worktree_fs/resolve.rs:26-51` refuses symlinked components via `cap-std`; `git/write/files.rs:93-95`; `git/write/ignore.rs:79`); git argument injection guard (`git/write/operands.rs:14` refuses leading `-`, `:101` refuses `..`); the single `unsafe` block (`git/write/open_path.rs:131`, Windows `ShellExecuteW` over NUL-terminated wide strings built at `:128-129`) is sound; CI `pull_request_target` runs with a read-only token, no secrets, and a trusted-user runner gate (`.github/workflows/ci.yml:33,57-59,72`); the docs deploy deliberately avoids `pull_request_target` (`docs.yml`); no secret content was ever committed (history grep for `ghp_`/`glpat-`/`AKIA`/`PRIVATE KEY` found nothing; pathspec hits for `*token*` are source files such as `provider_tokens.rs`).
- **Not verified**: failure handling of the `window-state` and `dialog` plugins (no explicit error handling found; Tauri defaults apply); whether `bun audit` passes locally (timed out; CI runs it at `ci.yml:151`).

## Capabilities

### New Capabilities

- `platform/security`: app-level security invariants — external link scheme gate, updater signature verification on every channel, macOS release signing/notarisation, consistency between markdown image policy and CSP, and safe hand-off of user paths to OS openers. *New area justification:* none of the areas in `openspec/config.yaml` (graph, changes, review, conflicts, pull-requests, forge, accounts, identities, refs, worktrees, history, terminal, agents, onboarding, chrome, ipc) owns packaging or content-security policy; these requirements are observable to users (Gatekeeper prompts, blocked images, refused links) but not tied to one feature.

### Modified Capabilities

- None.

## Impact

- Config: `src-tauri/tauri.conf.json` (CSP, `signingIdentity`), `src-tauri/capabilities/default.json` (comment only).
- CI: `.github/workflows/release.yml` `release-app` job — Apple certificate import + notarisation env, conditional on secrets.
- Rust: `shell.rs::reveal`, `git/write/reveal.rs`, `git/write/open_path.rs` — argument terminator / absolute path.
- Frontend: `src/components/ui/Markdown.tsx` — image host allow-list becomes the single source the CSP is generated from (or the CSP is widened to match).
- Docs: `docs/tauri-plugin-decisions.md` gains the CSP/capability rationale; `docs/release-channels.md` gains the signing requirement.
- Secrets/auth/IPC risk: Apple signing credentials live only in GitHub Actions secrets and are never read by app code. No IPC change.

## Non-goals

- Adding any Tauri plugin (`shell`, `fs`, `http`) or capability.
- Windows Authenticode signing (separate decision; not blocked by this change).
- Changing how provider tokens or HTTPS credentials are stored (covered by `harden-ipc-contract`).
- Sandboxing subprocesses.
