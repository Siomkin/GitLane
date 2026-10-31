# Proposal

Jira: none yet.

## Why

The update flow has two gaps. A user who doesn't want a release yet can't make the titlebar
indicator go away: it comes back on every launch until they install. And the user can't see
what an update contains. The manifest's `notes` is the fixed line "Desktop builds for
GitLane…" (`MANIFEST_NOTES` in `release.yml`), so the About card has nothing useful to show,
even though every GitHub Release already has a curated "What's changed" body.

## What Changes

- **Skip this version.** When an update is offered, the user can skip that exact version. A
  quiet launch check that finds the skipped version shows no indicator and counts as "nothing
  to install" for the daily throttle. A newer release replaces the skip without any action.
  A manual "Check for updates" still shows the skipped version, labelled as skipped, and the
  user can install it from there.
- **What's new.** GitLane fetches the GitHub Release notes for every version after the
  running one, up to the offered one, filtered by channel (stable leaves out pre-releases,
  beta includes them). It renders them newest first as sanitized markdown.
- **"What's new" dialog.** Clicking the titlebar update indicator opens a dialog instead of
  Settings → About. The dialog shows the version list and notes plus the actions for the
  current state: Install, Skip this version or Later while an update is offered, progress
  while downloading, and Relaunch once installed.
- **About card.** The Settings → About software-update card replaces its notes area with the
  same version list and gains "Skip this version" when an update is offered.
- **Design brief.** `design.md` carries a UI brief for the Claude Design project (screens,
  states, copy). The dialog and card UI is built to the resulting mockup.
- Release notes failing to load (offline, rate-limited) never blocks checking, installing, or
  the indicator. The dialog falls back to a link to the GitHub Releases page.

## Capabilities

### New Capabilities
- `chrome/software-update`: how GitLane offers updates. This covers when the indicator shows,
  skipping a version, manual checks, the What's new dialog and About card, and how release
  notes are chosen and shown. No existing spec covers the updater (`platform/security`
  covers only signature verification, which this change does not touch).

### Modified Capabilities
None. The new dialog joins the modal family, so `chrome/overlays`' existing "Escape closes
the topmost open layer" requirement applies to it unchanged.

## Non-goals

- A "what's new" screen shown after relaunch (considered, not chosen).
- Changing the release workflow or `latest.json` (notes come from the Releases API instead).
- Auto-download, snooze timers, or a global "never show updates" switch. The existing
  auto-check toggle already covers the last one.
- Skipping a download that is in progress or already installed (`downloading` / `ready`).
- Changes to signing, channels, or endpoints.

## Impact

- **Processes:** Rust (new command), IPC (four layers + `LOCAL_ONLY`), frontend (store,
  prefs slice, dialog, About card, indicator).
- **Rust:** `src-tauri/src/updater.rs` becomes a facade with `updater/release_notes.rs`.
  A new `list_release_notes` command goes in `commands/updater.rs`, registered in `lib.rs`
  and listed in `registration_tests/remote_split.rs`'s `LOCAL_ONLY` next to
  `check_update_on_channel`. The command reuses `git::oauth::http::UreqTransport::get`, the
  way `git/forge/gitlab` does, and adds `semver` as a direct dependency (it is already in
  `Cargo.lock` through the updater plugin).
- **Frontend:** `src/store/updates.ts`, `src/store/ui/updatePrefs.ts` (persisted
  `skippedUpdateVersion`), `src/store/ui/dialogs.ts`, `src/lib/api/updater.ts` +
  `schemas/updater.ts`, `UpdateIndicator.tsx`, `settings/UpdateSection.tsx`, and a new dialog
  folder under `chrome/overlays/` mounted in `app-shell/AppOverlays.tsx`. Notes render
  through the existing `components/ui/Markdown.tsx`.
- **Security/secrets:** no secrets or tokens are involved. The request is an unauthenticated
  GET to the public `api.github.com` releases list, made from the Rust process, so the CSP
  doesn't change. Release bodies are untrusted markdown and go through the same sanitizer and
  link opener as PR bodies. `docs/tauri-plugin-decisions.md` records `ureq`'s new caller and
  `semver`.
- **Docs:** `docs/release-channels.md` notes that release bodies are now user-visible
  in-app.
