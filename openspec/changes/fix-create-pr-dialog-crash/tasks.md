# Tasks

## 1. Selector fix and regression test

- [x] 1.1 Add `src/features/pull-requests/create-pr/CreatePrDialog.forgeAccounts.test.tsx`, following the `vi.hoisted` + `vi.mock` invoke pattern of `CreatePrDialog.test.tsx`. Cover two cases. (a) The Bitbucket forge with a stored Bitbucket provider token whose `transportUsername` is `alice`, opened through `openCreatePr("feature/x")`. (b) The GitLab forge with a stored GitLab token and no glab-capable auth status. Each case asserts that the dialog renders, that "Opening as" shows the login, and that typing a title updates the field. Verify: run `bun run test -- CreatePrDialog.forgeAccounts` on the unfixed code and confirm it FAILS ("Maximum update depth exceeded" or a getSnapshot-cache error); record that in the PR description.
- [x] 1.2 In `useCreatePrForm.ts`, replace `useAccounts((s) => s.prAccountRef())` with two primitive selectors (`?.login ?? null` and `?.host ?? null`), and build `account` from them during render (design Decision 1). Verify: 1.1 passes, and `CreatePrDialog.test.tsx` still passes unchanged.
- [x] 1.3 Sweep `src/` for other reactive selectors that call a store function or return a freshly built object or array, using a grep such as `use[A-Z]\w*\(\(?\w+\)? *=> *\w+\.\w+\(`, then read each hit's return type. Fix any that can return a new reference per call, the same way as 1.2. Verify: list each hit and its verdict in the PR description; any fix keeps its owner's tests green.

## 2. Overlay and PR-list containment

- [x] 2.1 Add an `OverlayBoundary` beside `AppOverlays.tsx` (under `src/app-shell/`). It wraps `ErrorBoundary`. If the entry has a `close`, its fallback is an `ErrorFallback` card inside `ModalFrame` (so it joins the Escape owner stack), and Close or Escape runs `entry.close()` and then `reset()`. If the entry's `close` is `null`, it renders nothing. Verify: a dom test with a child that throws shows the card; Close calls the entry's close and re-renders the (now closed) child; Escape does the same.
- [x] 2.2 Turn `AppOverlays` into a typed registry (`{ id, Overlay, close }[]`) where each entry renders through `OverlayBoundary`. Map each overlay to its real ui-store close action (for example `closeCreatePr`, `closeOverlays` for menus, and each dialog slice's close). `Toasts` and `Tooltip` get `close: null`. Verify: a test asserts every registry entry renders inside a boundary, and that with a throwing `CreatePrDialog` mock the rest of the app still renders and Close clears `createPrOpen`.
- [x] 2.3 In `App.tsx`, wrap `LeftPanel` (pulls layout) in `ErrorBoundary` with `resetKeys={[summary?.path]}`, plus `ErrorFallback` with Retry, copying the `TerminalLayer` wrapper. Verify: a dom test with a throwing PR-list mock shows the card while `CenterWorkspace` stays mounted.
- [x] 2.4 Verify `bun run sizes` and `bun run cycles` pass for the new and edited files.

## 3. `report_frontend_error` command (four IPC layers)

- [x] 3.1 Add `src-tauri/src/diagnostics.rs` with `FrontendErrorKind`, `FrontendErrorReport` (serde camelCase) and `append_frontend_error(log_dir, report)`, as in design Decision 4: per-field 16 KiB cap on a char boundary, `redact_secrets` on every field, an RFC 3339 timestamped entry, and a 512 KiB file cap that keeps the newest half, cut at an entry boundary. Verify with Rust unit tests in a temp dir: the entry format; `https://u:secret@h/r.git` is written as `https://u:***@h/r.git`; an oversized append keeps the file under 512 KiB with the newest entry last; a field over 16 KiB is truncated without panicking on multi-byte text.
- [x] 3.2 Add `src-tauri/src/commands/diagnostics.rs`: `pub async fn report_frontend_error(app, report) -> Result<(), CommandError>`, which resolves `app_log_dir()` and calls 3.1 inside `blocking(move || …)`. Register the module in `commands/mod.rs` and add its path-qualified line to `generate_handler!` in `lib.rs`. Verify: `cargo check`, plus the `registration_tests` suite (handler present, async, no credential-named parameter).
- [x] 3.3 Add `src/lib/api/diagnostics.ts` with the typed `reportFrontendError` wrapper and its `FrontendErrorReport` interface (camelCase), and re-export it from `src/lib/api/index.ts`. Verify: `bunx tsc --noEmit`, plus a node test that mocks `invoke` and asserts the command name and argument shape.
- [x] 3.4 Add a note to the Log row in `docs/tauri-plugin-decisions.md`: the plugin is still Deferred, and the only log is the redacted, size-capped `frontend-errors.log` written by `report_frontend_error`. Verify: the doc names the file, the cap and the redaction.

## 4. Root hooks and last-resort fallback

- [x] 4.1 In `src/main.tsx`, pass `onUncaughtError` and `onCaughtError` to `createRoot`, each calling a small reporter. The reporter maps the error and `errorInfo.componentStack` to `reportFrontendError`, caps reports at 20 per page load, swallows rejections, and still runs `console.error` in dev. Put the reporter in `src/lib/` so it can be tested. Verify: a node test asserts the mapping, the 20-report cap, and that a rejected `invoke` does not throw.
- [x] 4.2 Wrap `<App />` in `main.tsx` in `ErrorBoundary`, with a full-window `ErrorFallback` ("GitLane hit an error") whose action calls `window.location.reload()`. Verify: a dom test with a throwing `App` mock renders the fallback and the Reload button.
- [x] 4.3 Verify `bun run cycles` still passes with `main.tsx` importing the reporter.
- [x] 4.4 Empirical check: temporarily reintroduce the unstable selector (the old line 50) and render `AppOverlays` with the Bitbucket fixture from 1.1. Record whether React 19 routes the update-depth error through `OverlayBoundary` (card shown, `onCaughtError`) or reports it as uncaught (`onUncaughtError` only). Then revert the probe. Verify: write the outcome into design.md under Risks / Trade-offs, replacing the "may not route" wording with what was observed.

## 5. Title prefill

- [x] 5.1 In `useCreatePrForm.ts`, add the one-shot title seed from `range.commits[0].summary` behind a `titleSeededRef` (design Decision 5). Verify with dialog tests in `CreatePrDialog.forgeAccounts.test.tsx` (or a sibling test file if the size ratchet objects), one per spec scenario. The title equals the newest commit's summary once `range_commits` resolves. A title typed before the range resolves is kept. A cleared title stays empty after the base changes. An empty range leaves the title empty.
- [x] 5.2 Check that the existing `CreatePrDialog.test.tsx` cases still pass, and update any that asserted an empty title after the commits loaded. Verify: `bun run test -- CreatePrDialog` is green, and each changed assertion is listed in the PR description.

## 6. Integration checks

- [x] 6.1 Run the `verify` agent (tsc, cargo fmt/clippy, vitest, sizes, cycles). Verify: every check exits 0, with the log paths recorded.
- [ ] 6.2 In `bun run tauri dev`, on a Bitbucket repository with a stored token, choose "Open a pull request…" from a branch's context menu. Verify: the dialog opens with the branch's last commit subject as its title, "Opening as" shows, typing works, and the window never blanks.
- [ ] 6.3 In `bun run tauri dev`, force an overlay render error (temporary throw in a dev build, not committed). Verify: the error card appears, Close and Escape dismiss it, and an entry appears in `frontend-errors.log` under the app log directory (macOS: `~/Library/Logs/space.gitlane.desktop/`).

## Workflow follow-up

- Run `/opsx:archive fix-create-pr-dialog-crash` after the PR merges.
