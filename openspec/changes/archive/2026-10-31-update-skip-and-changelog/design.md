# Design

## Context

The update flow is one store, `src/store/updates.ts`, with two views: the titlebar
`UpdateIndicator` and the Settings → About `UpdateSection` card. `checkOnLaunch` runs a quiet
`check({ quiet: true })` at most once a day (`autoCheckUpdates`, `lastUpdateCheckAt` in
`src/store/ui/updatePrefs.ts`). The manual button calls `check()`. `check` stamps the
throttle only when nothing is found, so a pending update comes back after a relaunch.
`check_update_on_channel` (`src-tauri/src/updater.rs`) rebuilds the plugin updater against
the stable or beta manifest and returns `UpdateMetadata`. Its `body` is the manifest
`notes`, which the release workflow fills with a fixed line (`MANIFEST_NOTES`). The real
notes live only in each GitHub Release body, written per release by the `bump-version`
runbook (`## What's changed`, a "Full changelog" link, and a "macOS build is unsigned"
footer when signing was off).

Constraints: the CSP `connect-src` allows only IPC, so the webview can't call
`api.github.com`. The backend already has one outbound HTTP client, `UreqTransport` in
`git/oauth/http/`, which `git/forge/gitlab` reuses. It has a 30 s timeout and the
`User-Agent: GitLane` header GitHub requires. `components/ui/Markdown.tsx` already renders
untrusted GitHub markdown (sanitized; links go through `openExternalUrl`).

## Goals / Non-Goals

**Goals:**
- Skip logic in one place, the store's `check`. The indicator, dialog and card stay views.
- Release notes are a separate, lazily loaded resource. Notes can't fail a check or an
  install.
- One component for the version list and one for the action row, shared by the dialog and the
  About card.

**Non-Goals:**
- An "un-skip" control. A manual check already shows the skipped version with Install.
- Pagination past the first page of the Releases API (see Risks).
- Caching notes across sessions.

## Decisions

### 1. Engine: Rust fetches GitHub Releases with the existing `UreqTransport`

`list_release_notes` sends `GET https://api.github.com/repos/Siomkin/GitLane/releases?per_page=50`
through `UreqTransport::get_with_limit` (`PROVIDER_JSON_RESPONSE_LIMIT`, 4 MiB) with
`Accept: application/vnd.github+json`. The request is unauthenticated and the repo is public.
It runs inside `blocking(…)` because `ureq` is blocking.

Alternatives:
- **Notes in `latest.json`.** Gives only the newest version, and the workflow would have to
  copy the body after the notes are written, which happens after publish.
- **Webview `fetch`.** Needs a CSP `connect-src` widening.
- **`gh api`.** Not every user has `gh`, and it is account-bound.

The releases URL is a constant next to `STABLE_ENDPOINT`. A unit test asserts both name the
same `owner/repo`, the same drift guard as the existing endpoint tests.

### 2. Filtering and boilerplate stripping happen in Rust

`updater/release_notes.rs` is a pure function from the parsed release list plus
`(current, offered, beta)` to the DTO, so it unit-tests without network:
- Drop drafts. Drop `prerelease` unless `beta`.
- Parse `tag_name` without its leading `v` as `semver::Version`, and ignore tags that don't
  parse. Keep `current < v <= offered`, sorted newest first. Take 10. Set `hasMore` when
  more than 10 matched, or when the oldest release on the page is still newer than `current`
  (the range runs past page 1).
- Body: drop a leading paragraph that starts with `Desktop builds for GitLane.` and a trailing
  `macOS build is unsigned` line, then trim. An empty result becomes `null`, which the UI
  shows as "No release notes".

`semver` (1.x) becomes a direct dependency, `optional = true` and enabled by the `desktop`
feature (`"dep:semver"`) like `tauri-plugin-updater`, because the agent build has no updater.
It is already in `Cargo.lock` through `tauri-plugin-updater`, so the build tree doesn't
change. Comparing tag strings, or stopping
at the current tag in API order, breaks when the user switches channel (for example
`2.5.0-beta.2` → stable `2.5.0`).

A test reads `.github/workflows/release.yml` with `include_str!` and asserts it still contains
the boilerplate prefix and the unsigned footer text. If someone rewords the workflow, the test
fails before users start seeing the boilerplate.

Doing this in TypeScript was the alternative. It was rejected because the semver parse and the
drift test both fit Rust's existing updater tests.

### 3. IPC: one new command, four layers plus `LOCAL_ONLY`

- **Impl:** `src-tauri/src/updater.rs` becomes the facade over `updater/release_notes.rs`
  (fetch + filter). `check` stays where it is. `mod updater` is already behind
  `#[cfg(feature = "desktop")]` in `lib.rs` (as is `commands::updater`), so the submodule
  inherits the gate and the agent build is unaffected.
- **Command + registration:** `list_release_notes(current_version: String,
  offered_version: String, beta: bool) -> Result<ReleaseNotes, CommandError>` in
  `commands/updater.rs`, async + `blocking`, registered in `lib.rs`'s `generate_handler!`, and
  added to `LOCAL_ONLY` in `commands/registration_tests/remote_split.rs` (the updater is a
  desktop concern, the same as `check_update_on_channel`). Invalid semver inputs return a
  `CommandError`.
- **Types:** `ReleaseNotes { releases: Vec<ReleaseNote>, has_more: bool }`
  and `ReleaseNote { version, name: Option<String>, published_at: Option<String>,
  body: Option<String>, url: String }`, camelCase, beside `UpdateMetadata` in the updater
  module (updater DTOs don't live in `git/types/`). `published_at` passes GitHub's RFC 3339
  string through as is, so there's no `time` dependency.
- **TS:** `listReleaseNotes(currentVersion, offeredVersion, beta)` in `src/lib/api/updater.ts`
  with a zod `releaseNotesSchema` in `src/lib/api/schemas/updater.ts` (`assertEqual` against
  the interface, like `updateMetadataSchema`). `lib/updater.ts` re-exports it so the store's
  seam stays mockable. It also holds a `RELEASES_PAGE_URL` constant
  (`https://github.com/Siomkin/GitLane/releases`) for the error and overflow links. That link
  must work when the request failed and there is no DTO, so it can't come from the response.

### 4. Skip state: one persisted string, applied only in `check`

- `updatePrefs.ts` gains `skippedUpdateVersion: string | null` (default `null`, added to
  `PERSISTED`) and `setSkippedUpdateVersion`. Rehydration accepts only a string or `null`.
- `updates.ts` `check({ quiet })`: when an update is found, `quiet` is true, and
  `update.version === skippedUpdateVersion`, call `markUpdateChecked()` and set
  `status: "idle"` with the handle and metadata cleared. The indicator stays dark and the card
  shows "Check for updates", not "You're up to date". A manual `check()` ignores the skip.
- A new `skip()` action works only from `status === "available"`. It persists `newVersion`,
  resets to `idle` the same way, and closes the dialog.
- Both paths drop a live plugin `Update` whose `rid` is still parked in the webview resource
  table. No path does that today, so each first calls `await update.close()` (the plugin's
  `Update` is a `Resource`) and swallows any error. Otherwise every skipped check leaks one
  resource.
- Views derive the "skipped" label as `newVersion === skippedUpdateVersion` with a normal
  `useUi` selector (a component subscribing is fine; only cross-store reads inside actions must
  be one-shot).

Alternative: a new `UpdateStatus` value `"skipped"`. Rejected because every `switch` on status
(card presentation, indicator, `hasPendingUpdate`) would have to learn it, while `idle`
already renders the right card.

### 5. Notes state in the updates store, separate from check state

`releaseNotes: { forVersion: string; state: "loading" | "loaded" | "error"; data: ReleaseNotes | null } | null`
plus `loadReleaseNotes()`. It does nothing when no update is offered, or when `forVersion`
already equals `newVersion` and the state isn't `error`. It reads the channel one-shot from
`useUi`. The dialog and the About card call it from an effect when they render an offered
update, so notes are fetched at most once per offered version per session, and only when
someone looks. Errors set `state: "error"` only. They never touch `status`, `error`, or toasts.

### 6. Dialog lives in the dialogs slice and the overlay registry

- `src/store/ui/dialogs.ts`: `whatsNewOpen: boolean`, `openWhatsNew()`, `closeWhatsNew()`,
  included in `overlayOpenDialogs` (the Escape/topmost rule in `chrome/overlays`) and **left
  out of** `resetDialogs`, because the dialog isn't repo-bound.
- `src/app-shell/AppOverlays.tsx` registers it like `reflog-recovery` (`isOpen`, `close`).
- `UpdateIndicator` calls `openWhatsNew()` instead of `openSettings("about")`.
- New folder `src/components/chrome/software-update/`:
  - `WhatsNewDialog.tsx`: `ModalFrame` + `DialogTitle` / `DialogFooter`.
  - `ReleaseNotesList.tsx`: version sections rendered with `Markdown`, plus the loading,
    error and `hasMore` states.
  - `UpdateActions.tsx`: the state → buttons + progress bar, extracted from `UpdateSection`.
  - `index.ts`.

  `settings/UpdateSection.tsx` keeps its header, swaps its notes block for
  `ReleaseNotesList`, and uses `UpdateActions` (which adds "Skip this version"). Every file
  stays well under the 400-line ceiling, so no further split is needed.

### 7. Store placement

Stores touched: `updates` (skip, notes), `ui` (`updatePrefs` slice, `dialogs` slice). No new
store, and nothing goes into `repo` or `pulls`. `ui` doesn't import `updates`. `updates`
imports `ui` (as it does today). Import direction is unchanged.

## Design brief (for the Claude Design project)

Make `Software Update.dc.html` in the Claude Design project, matching the existing Titlebar
and About visuals (`UpdateIndicator` and `UpdateSection` were drawn there). Draw light and
dark versions. Every interactive element gets a focus ring.

**A. What's new dialog** (opened from the titlebar indicator; ModalFrame, about 560 px wide,
body capped near 60 vh and scrolling)
- Header: title "What's new". The subtitle shows the version step, "GitLane 2.4.1 → 2.4.3",
  plus a small "Beta" badge on the beta channel.
- Body: one section per version, newest first.
  - Version heading ("2.4.3") with the release date (secondary text) and a "Latest" tag on
    the top section.
  - Markdown notes (headings, bold "Fixed:/Changed:" lead-ins, bullet lists, links), as in
    the real 2.4.3 release body.
  - Draw these states: a loading skeleton (2–3 bars); an error state: "Couldn't load release
    notes." with a "View on GitHub" link; a version with "No release notes"; the overflow
    footer "and 4 earlier versions — View all releases on GitHub".
  - When the version was skipped, a "Skipped" chip next to the top version heading.
- Footer, by state:
  - Offered: "Skip this version" as a quiet text button at the left, "Later" (secondary) and
    "Install update" (accent) at the right.
  - Downloading: the footer becomes a progress bar plus "42% — 18 MB of 43 MB" and a single
    "Hide" (secondary).
  - Installed: "Later" and "Relaunch" (accent).
  - Failed download: an inline error line plus "Retry download" (accent).

**B. About card additions** (Settings → About, existing card)
- Offered: next to "Install update", add "Skip this version" (secondary). Below the header,
  the old single notes block becomes a collapsible "What's new · 2 versions" section using the
  same version list (max height about 240 px, scrolling).
- Offered after a manual check of a skipped version: subtitle "Version 2.5.0 — you skipped
  this version." with "Install update" and no skip button.
- After a silent skip, the card is the existing idle state ("Check for updates") and needs no
  new art.

**C. Titlebar indicator.** The look doesn't change. The tooltip copy stays. Only the click
target changes (the dialog instead of Settings).

Copy is final unless the mockup changes it. The implementation follows the `.dc.html` the way
`repo-tab-group-collapse` followed `Tab Groups.dc.html`.

## Risks / Trade-offs

- [Unauthenticated GitHub API limit is 60 requests/hour per IP] → Notes load only when a view
  opens with an update offered, once per version per session. Failure falls back to a link.
- [More than 50 releases between the running and offered versions] → Only page 1 is read
  (`shortcut: first page only, add Link-header pagination if users fall >50 releases
  behind`). The list still shows the newest ≤10, and `hasMore` plus the link covers the rest.
- [Release bodies are untrusted markdown] → They render through `Markdown.tsx` (sanitizer +
  safe-scheme opener), the same path PR bodies use. Image hosts stay CSP-bound.
- [The boilerplate text changes in `release.yml`] → The `include_str!` drift test fails.
- [A skipped version whose fix the user later needs] → A manual check always shows it, with
  Install.
- [The repo is renamed] → The releases-URL constant and its owner/repo test sit next to the
  manifest endpoints.

## Migration Plan

`skippedUpdateVersion` is a new persisted key that defaults to `null`, so existing installs
behave as today until someone skips. Nothing to migrate and nothing to roll back: removing the
feature leaves an unused key in localStorage.
