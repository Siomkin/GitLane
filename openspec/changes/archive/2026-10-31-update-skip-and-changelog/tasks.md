# Tasks

## 1. Design mockup

- [x] 1.1 Make the Software Update mockup in Claude Design from the brief in design.md ("Design brief"): the dialog states A (offered, skipped after a manual check, downloading, installed, notes failed, dark) and the About card additions B, on the GitLane Design System. Delivered as the "Software Update" design canvas (https://claude.ai/artifact/Fy3DEgEqmVvK8LWYjSX9Uh); groups 5–6 match it.

## 2. Rust: release notes command

- [x] 2.1 Add `semver = { version = "1", optional = true }` to `src-tauri/Cargo.toml` with `"dep:semver"` in the `desktop` feature, and confirm `Cargo.lock` adds no new package (`git diff src-tauri/Cargo.lock` shows only the direct-dependency edge). Verify with `(cd src-tauri && cargo check)`.
- [x] 2.2 Turn `src-tauri/src/updater.rs` into a facade and add `updater/release_notes.rs`: the releases-API URL constant, the `ReleaseNotes` / `ReleaseNote` camelCase DTOs, a pure `select(releases, current, offered, beta)` (drafts and channel filter, semver range `current < v <= offered`, newest first, cap 10 + `has_more` (also true when the page ends before reaching `current`), boilerplate strip, empty → `None`), and `fetch` via `UreqTransport::get_with_limit` with `Accept: application/vnd.github+json`. Verify with unit tests in `updater/release_notes/tests.rs`: stable excludes pre-releases, beta includes them, a channel switch (`2.5.0-beta.2` → `2.5.0`), unparsable tags ignored, the cap and `has_more` (more than 10 matched; a range running past page 1), boilerplate and unsigned footer stripped, an empty body → `None`, a non-2xx response → error (via `git::oauth::http::testing::MockTransport`).
- [x] 2.3 Add drift tests: the releases URL names the same `owner/repo` as `STABLE_ENDPOINT`, and `include_str!` of `.github/workflows/release.yml` still contains the boilerplate prefix and the `macOS build is unsigned` text. Verify with `(cd src-tauri && cargo test updater)`.
- [x] 2.4 Add `list_release_notes(current_version, offered_version, beta)` to `src-tauri/src/commands/updater.rs` (async + `blocking`, invalid semver → `CommandError`), register it in `lib.rs` `generate_handler!`, and add it to `LOCAL_ONLY` in `commands/registration_tests/remote_split.rs`. Verify the registration tests pass with `(cd src-tauri && cargo test registration_tests)`, then run `cargo fmt --all -- --check` and both clippy invocations from CLAUDE.md (default features and `--no-default-features --features agent`).
- [x] 2.5 Record the second `ureq` caller and the `semver` direct dependency in `docs/tauri-plugin-decisions.md` (no CSP change, Rust-side), and add a line to `docs/release-channels.md` that release bodies are now shown in-app (keep "What's changed" user-readable; the first boilerplate line and the unsigned footer are stripped). Verify both docs name `list_release_notes`.

## 3. Frontend IPC wrapper

- [x] 3.1 Add `ReleaseNotes` / `ReleaseNote` interfaces and `listReleaseNotes(currentVersion, offeredVersion, beta)` to `src/lib/api/updater.ts`, the `releaseNotesSchema` zod schema with `assertEqual` in `src/lib/api/schemas/updater.ts`, and a seam export plus the `RELEASES_PAGE_URL` constant in `src/lib/updater.ts`. Verify with `bun check` and a test (`src/lib/api/updater.test.ts`) that accepts a sample payload with `null` body/name/publishedAt and rejects a missing `hasMore`.

## 4. Store: skip and notes

- [x] 4.1 Add `skippedUpdateVersion: string | null` + `setSkippedUpdateVersion` to `src/store/ui/updatePrefs.ts` and to `PERSISTED`, with rehydration coercing anything other than a string to `null`. Verify with a test (`src/store/ui.test.ts`) that it persists and that a rehydrated number becomes `null`.
- [x] 4.2 In `src/store/updates.ts`: the quiet `check` that finds the skipped version stamps `markUpdateChecked()` and goes to `idle` with the handle and metadata cleared; a manual `check()` ignores the skip; a new `skip()` works only from `available`, persists `newVersion`, resets to `idle` and closes the What's new dialog. Both paths `close()` the dropped `Update` handle first. Verify in `src/store/updates.test.ts`: quiet + skipped → idle, throttle stamped, no indicator (`hasPendingUpdate` false), handle closed; `skip()` closes the handle; quiet + a different version → available; manual + skipped → available; `skip()` is a no-op while `downloading` or `ready`.
- [x] 4.3 Add `releaseNotes` state and `loadReleaseNotes()` to `src/store/updates.ts` (one-shot channel read, once per offered version, retry only after `error`, errors never touch `status` / `error` / toasts). Verify in `updates.test.ts`: one IPC call across two loads, a failed load leaves `status: "available"` and shows no toast, and a new offered version refetches.

## 5. What's new dialog

- [x] 5.1 Add `whatsNewOpen` / `openWhatsNew` / `closeWhatsNew` to `src/store/ui/dialogs.ts`, include it in `overlayOpenDialogs`, keep it out of `resetDialogs`, and register the overlay in `src/app-shell/AppOverlays.tsx`. Verify `src/components/chrome/overlays/modality.test.tsx` (extend it to cover the new dialog) passes and that a repo switch leaves the dialog open.
- [x] 5.2 Create `src/components/chrome/software-update/` with `ReleaseNotesList.tsx` (versions via `components/ui/Markdown`, skipped chip, loading / error / no-notes / `hasMore` states, links to `RELEASES_PAGE_URL`, including the error state), `UpdateActions.tsx` (state → buttons + progress, extracted from `UpdateSection`), `WhatsNewDialog.tsx` (ModalFrame, built to the mockup from 1.1), and `index.ts`. Verify with `WhatsNewDialog.test.tsx`: the offered state shows Install, Skip this version and Later; Later closes and keeps the update pending; Skip calls `skip()`; `ready` shows only Relaunch and Later; a notes error still shows Install; Escape closes.
- [x] 5.3 Point `UpdateIndicator` at `openWhatsNew()` instead of `openSettings("about")`. Verify with a test that clicking the indicator opens the dialog and not Settings.

## 6. About card

- [x] 6.1 Rework `src/components/chrome/settings/UpdateSection.tsx` to use `UpdateActions` (adding "Skip this version" while offered) and replace its notes block with the collapsible `ReleaseNotesList`, matching the mockup; show "you skipped this version" when `newVersion === skippedUpdateVersion`. Verify by updating `UpdateSection.test.tsx`: the skip button appears only while offered, the skipped label appears after a manual check of a skipped version, and the idle state after a silent skip shows "Check for updates", not "You're up to date".

## 7. Integration check

- [x] 7.1 Run the full suite through the `verify` agent (`bun check`, `bun run test`, cargo fmt/clippy (both feature sets), `bun run sizes`, `bun run cycles`) and confirm every exit code is 0.
- [x] 7.2 Check the live notes once from `bun run tauri dev` (updates are unsupported in source builds, so drive `list_release_notes("2.4.1", "2.4.3", false)` from a temporary `#[ignore]` test against the live API). Confirm it returns 2.4.3 and 2.4.2 with the boilerplate stripped; the offline path is covered by the transport-failure unit test and `UreqTransport`'s 30 s timeout.
