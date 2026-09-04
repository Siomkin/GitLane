## Context

See proposal.md for the inventory. Specs: `platform/security` (new area — packaging, CSP, and OS-opener invariants are not owned by any existing capability). Engine and IPC signatures are unchanged. External-link scheme gating already lives in `src/lib/openExternal.ts` and the opener capability allow-list; updater minisign verification is already on for both channels. This design is the remaining how: CSP ↔ markdown agreement, absolute-path opener assertions, and guarded Apple signing.

## Goals / Non-Goals

**Goals:** one image-host list shared by the markdown renderer and CSP; opener paths that cannot be read as flags; Apple signing/notarisation that is either fully on (secrets present) or explicitly labelled unsigned (secrets absent), never an empty-env false start.

**Non-Goals:** generating `tauri.conf.json` from TypeScript; adding `--` to macOS `open` (Apple uses `--` to forward args to the opened app); Windows Authenticode; changing how updater minisign keys are stored.

## Decisions

### 1. Image allow-list: TypeScript is the runtime source; CSP is the static copy; a test binds them

`isTrustedImageSrc` in `src/components/ui/Markdown.tsx` stays the only runtime gate (sanitiser + `<img>` renderer). Extract the HTTPS host rule into a named helper next to it (`host === "githubusercontent.com" || host.endsWith(".githubusercontent.com")`) so the test and the comment in `tauri.conf.json` name the same function.

CSP stays a string in `src-tauri/tauri.conf.json` — Tauri reads it at bundle time; there is no TS → JSON generation step in this repo. After dropping `asset:` / `https://asset.localhost`, `img-src` is `'self' data: https://*.githubusercontent.com`. A vitest parses that string and asserts every `https:` host in `img-src` is accepted by `isTrustedImageSrc` (and the reverse: the GitHub user-content pattern is present in CSP). Off-list images already render as alt-text `<span>`s (`Markdown.test.tsx`); keep that and add the CSP-parity assertion beside it.

`img.shields.io` stays **out** of both lists. `priorityBadge` already turns those URLs into a local chip and never emits `<img>`, so allowing the host in CSP would load a remote resource the renderer has already decided not to fetch.

Alternative: a shared JSON file imported by Vite and copied into CSP by a build script. Rejected — one extra generation step for two host patterns, and CSP is otherwise hand-edited.

### 2. `style-src-attr`: try it; fall back in the decision record if WebKit refuses

The 127 `style={…}` sites need inline *attribute* styles, not injected `<style>` elements. Target CSP: `style-src 'self'; style-src-attr 'unsafe-inline'`. CSP3 `style-src-attr` is in Safari 15.4+ (macOS 12). GitLane's shipped floor is whatever WebKit Tauri 2 embeds on the oldest macOS the DMG still launches on; that is **not** pinned as a `minimumSystemVersion` today (`tauri.conf.json` `bundle.macOS` only sets `signingIdentity`).

Apply path: set the tighter directive, launch `bun run tauri dev`, and check a screen that uses inline styles (ActionBar, graph rows). If attributes are stripped, revert to `style-src 'self' 'unsafe-inline'` and record the finding plus the WebKit version in `docs/tauri-plugin-decisions.md`. Do not ship a CSP the current webview ignores.

### 3. OS openers: shared absolute-path check; `--` only on Linux

Add `fn require_absolute(path: &Path) -> Result<&Path, String>` in a small helper used by `shell::reveal`, `git/write/reveal.rs::reveal_path`, and `git/write/open_path.rs::open_default` (non-Windows branches). Refuse anything `!path.is_absolute()` before `Command` is built. Callers already resolve to worktree-absolute paths (`workdir.join`, normalised `summary.path`); this is the regression guard the spec requires, not a new resolution rule.

- **Linux `xdg-open`:** insert `--` before the path (`xdg-open -- /abs/path`). Documented operand terminator.
- **macOS `open` / `open -R`:** do **not** insert `--`. `open -- file` forwards subsequent args to the opened application; it is not a general option terminator. Absolute paths cannot start with `-`, so the assertion is the whole guard.
- **Windows `explorer /select,` and `ShellExecuteW`:** the path is already concatenated / wide-encoded, not a leading argv option. Still run `require_absolute` so a relative `-dash` name never reaches `/select,-dash`. `ShellExecuteW` is unchanged (still the GL-337 no-`cmd.exe` path).

Tests: unit-test `require_absolute` with `Path::new("-dash")` and a relative `foo`; platform `reveal_path` / `open_default` tests use `#[cfg]` branches and do not spawn Finder/Explorer in CI — they assert the error on a relative dash name. `open_path.rs` `rejects_missing_and_unsafe_paths` gains that case.

### 4. Apple signing: env injection only when secrets are non-empty; conf stays `"-"` as the unsigned default

Do **not** replace `bundle.macOS.signingIdentity: "-"` with a baked-in identity. Ad-hoc remains the local/`tauri dev` and "secrets absent" default. When the release job has Apple material, a prior step writes real values to `$GITHUB_ENV` so Tauri's bundler sees them; when it does not, those names are omitted entirely (the empty-string gotcha already documented at `release.yml:467-478`).

macOS legs of `release-app` gain a step:

```
if: secrets.APPLE_CERTIFICATE != ''
```

that imports the cert (`security import` into a temporary keychain), then appends `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and the notarisation trio (`APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`) to `$GITHUB_ENV`. The `tauri-action` env block still does **not** mention those names — it inherits them only when the step ran. If the cert is present, a failed `security import` or notarisation fails the job (spec: do not publish ad-hoc when signing is configured).

`publish-release` detects whether the macOS legs inherited signing by an output from `release-app` (e.g. `signed_macos=true|false` set in that same guard step). When false, it appends a sentence to the GitHub release body: `macOS build is unsigned`. Do not put that sentence in the updater `latest.json` notes — those are install-guide copy, not Gatekeeper status.

Document the secret names and the "unsigned if absent" behaviour in `docs/release-channels.md`, `docs/distribution.md` (GL-96 channel row: wiring lands here; enrollment still required to populate secrets), and the `bump-version` skill (check secrets / expect the unsigned label).

Alternative: fail the whole release when Apple secrets are missing. Rejected — Linux/Windows artifacts are still shippable, and enrollment (GL-96) is not this change's job.

### 5. Capabilities: document, do not edit

`src-tauri/capabilities/default.json` already has 17 permissions, each with a JS call site (proposal). Add a table to `docs/tauri-plugin-decisions.md` listing identifier → call site. No JSON change. `window-state` remains plugin-registered without an extra capability entry; do not add `window-state:default` here.

## Risks / Trade-offs

- [Tighter `style-src-attr` breaks inline styles on older WebKit] → verify in `tauri dev` and fall back (Decision 2).
- [Apple secrets still empty after this lands] → unsigned path stays green; release notes say so (Decision 4). First notarised DMG still needs GL-96 enrollment plus a dry-run beta (`spctl --assess`).
- [CSP host glob `https://*.githubusercontent.com` does not match the apex `githubusercontent.com`] → `isTrustedImageSrc` accepts both; real avatars use `avatars.githubusercontent.com`. Keep the apex in the TS helper; do not add a CSP line for a host we do not fetch.
- [`require_absolute` on Windows `Path` treats `C:\…` as absolute and `\…` as not] → tests cover a leading-dash relative name, not drive-letter trivia.

## Open Questions

None that block apply. `style-src-attr` support is a verification outcome of task 1.3, not a spec fork.
