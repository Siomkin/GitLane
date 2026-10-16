# Design

## Context

See proposal.md for the crash itself. The constraints that shape the fix:

- **`prAccountRef()` returns an unstable value.** It is a store function, not state. For GitHub it returns the stored `repoAccountRef`, which is the same reference every call. For Bitbucket (keychain token) and for GitLab (keychain token, no glab) it builds a new `{ provider, host, accountId, login }` on every call. It also reads the repo store's `forge` through `storeLinks.openRepo()`, a cross-store read, so a reactive subscription to it is outside the documented pattern anyway. Every other caller (`pulls/list.ts`, `pulls/writes.ts`, `pullsResource.ts`, `pullsActionOwner.ts`) correctly reads it through `getState()`. `useActionBarModel.ts` reduces it to a string key. `useCreatePrForm.ts:50` is the only reactive subscriber that keeps the object.
- **The dialog's only use of the account is display.** The form uses `account` only for the header label ("Opening as {login}", tooltip "on {host}"). The submit goes through `pulls/writes.ts`, which resolves the account itself.
- **`CreatePrDialog.test.tsx` misses this case.** It covers `forge: null`, GitHub and GitLab, never with a stored provider token, so `prAccountRef()` always returned `null` or a stored reference. The file is already 782 lines.
- **Error boundaries exist but miss these areas.** `ErrorBoundary` and `ErrorFallback` (`components/ui/`) already cover `CenterWorkspace` and `TerminalLayer`. `AppOverlays` (around 25 overlays), `LeftPanel`, `TitleBar` and `ActionBar` have none, and `main.tsx` mounts `<App />` with no root error options.
- **Each overlay closes through its own ui-store flag.** Examples: `createPrOpen` through `closeCreatePr`, `menu` through `closeOverlays`, plus the dialog slices. A generic wrapper cannot know which flag to clear.
- **The Rust side has no logging today.** There are two `eprintln!` calls, and `tauri-plugin-log` is Deferred in `docs/tauri-plugin-decisions.md` until redaction rules exist. `redact::redact_secrets` already scrubs `scheme://user:pass@host`. `commands/auth.rs` shows how to resolve an app directory in the command layer and pass a plain path down.

## Goals / Non-Goals

**Goals:**

- Remove the loop at its source with no new pattern, using plain primitive selectors.
- Make a regression test fail on today's code and pass after the fix.
- Make a failing overlay closable through the same path as the overlay itself, including Escape.
- Write a bounded, redacted local trace of every caught and uncaught render error, in release builds too.

**Non-Goals:**

- Memoising `prAccountRef()` inside the store, or changing its signature.
- Adding a lint rule for unstable selectors. The sweep in tasks.md is manual.
- Showing the user where the log lives. That is a later Settings or "About" affordance.
- Reading the log back over IPC.

## Decisions

### 1. Subscribe to primitives, not the account object

```ts
const accountLogin = useAccounts((s) => s.prAccountRef()?.login ?? null);
const accountHost  = useAccounts((s) => s.prAccountRef()?.host ?? null);
```

The form returns `account: accountLogin && accountHost ? { login, host } : null`. That object is built during render, not returned from a selector, so it cannot loop.

- **Over `useShallow`:** `useShallow` would also work, but nothing in `src/` uses it yet. Two string selectors are the codebase's existing idiom, and they state what the dialog actually depends on.
- **Over memoising inside `prAccountRef`:** memoising fixes every future reactive caller, but it puts cache state into a store function whose correct usage is already `getState()`. It also leaves the cross-store reactive read in place.
- **Over dropping reactivity entirely** (`useAccounts.getState().prAccountRef()` during render): rejected. The label would go stale if the token is signed out while the dialog is open, and the spec requires the label to follow the stored account.

### 2. One boundary per overlay, with the overlay's own close

`AppOverlays` becomes a typed registry instead of a bare fragment:

```text
const OVERLAYS: OverlayEntry[] = [
  { id: "create-pr", Overlay: CreatePrDialog, close: () => useUi.getState().closeCreatePr() },
  { id: "branch-menu", Overlay: BranchContextMenu, close: () => useUi.getState().closeOverlays() },
  ...
  { id: "toasts", Overlay: Toasts, close: null },   // silent: fallback renders nothing
];
```

Each entry renders as `<OverlayBoundary entry>`, a thin wrapper over the existing `ErrorBoundary`. Its fallback is an error card inside `ModalFrame`, so it joins the Escape owner stack (`useEscapeOwner`). Close and Escape both call `entry.close()` and then `reset()`. The overlay's flag clears first, the child renders `null`, and the next open mounts it fresh. Overlays that are always present and not user-closable (`Toasts`, `Tooltip`) get `close: null` and a silent `null` fallback. Their failure is logged (Decision 4) but never puts a card on screen.

- **Over one boundary around all of `AppOverlays`:** a single crash would take out every overlay, including toasts. Its Close also could not tell which flag to clear, so the broken dialog would stay "open" in the store, and `openCreatePr` is a no-op while `createPrOpen` is true.
- **Over remount keys:** they cannot reach the store flag either.

The file stays the single registry with one axis of change, which its header comment already promises. Copy the fallback styling from `CenterWorkspace`'s `ErrorFallback` use.

### 3. `LeftPanel` boundary and root fallback

- **`LeftPanel`:** in `App.tsx`, wrap it the way `TerminalLayer` is wrapped. Use `resetKeys={[summary?.path]}`, plus `ErrorFallback` with Retry.
- **Root fallback:** in `main.tsx`, wrap `<App />` in `ErrorBoundary`. Its fallback is a full-window `ErrorFallback` reading "GitLane hit an error", whose action calls `window.location.reload()`. This is the last resort for the title bar, the action bar and the app shell itself.

### 4. Root error hooks forward to a new `report_frontend_error` command

`createRoot(el, { onUncaughtError, onCaughtError })` calls `reportFrontendError({ kind, message, stack, componentStack })`. React 19 calls `onCaughtError` for errors a boundary caught, which covers every boundary above with one hook and no per-boundary `onError`. On the JS side:

- **Session cap:** at most 20 reports per page load, so a render loop cannot flood IPC.
- **No feedback loop:** the reporter swallows its own rejection.
- **Dev output kept:** `console.error` still runs in dev.

The command follows the four IPC layers:

1. **Impl:** a new `src-tauri/src/diagnostics.rs`. It is not under `git/`, because it is not a git concern. It exposes `append_frontend_error(log_dir: &Path, report: &FrontendErrorReport) -> io::Result<()>`, which does the following:
   - truncates each field to 16 KiB on a char boundary;
   - runs `redact_secrets` over every field;
   - formats one entry: an RFC 3339 timestamp, kind, message, stack, component stack, then a blank line;
   - writes `frontend-errors.log`, keeping the file under 512 KiB. If an append would cross the cap, it keeps the newest half of the existing content, cut at an entry boundary, before appending.
2. **Command and registration:** `commands/diagnostics.rs` declares `pub async fn report_frontend_error(app: AppHandle, report: FrontendErrorReport) -> Result<(), CommandError>`, using `blocking(move || …)`. It resolves `app.path().app_log_dir()` there, as `auth.rs` does for app data. Add the matching path-qualified line to `generate_handler!` in `lib.rs`.
3. **Types:** `FrontendErrorReport { kind: FrontendErrorKind (Caught | Uncaught), message: String, stack: Option<String>, component_stack: Option<String> }` with serde camelCase. It is declared in `diagnostics.rs`, because the config's rule is "the domain's types otherwise", not `git/types/`.
4. **TS wrapper:** a new flat `src/lib/api/diagnostics.ts` exporting `reportFrontendError`, re-exported from `lib/api/index.ts` like `terminal.ts` and `updater.ts`.

**Write failures** are mapped to `CommandError` and dropped by the JS caller. The app never surfaces a logging failure, as the spec requires.

**Over `tauri-plugin-log`:** the plugin stays Deferred. One append-only file behind one redacting command meets the "redaction rules first" bar for this narrow use without adopting a general logger.

**Over `eprintln!`:** a macOS `.app`'s stderr is not kept anywhere the user can find, which is exactly why this crash left no trace.

### 5. Title prefill from the range read the form already makes

`useRangeRead` returns `base..head` newest first (`git/read/range.rs` walks with `TOPOLOGICAL | TIME` from the head and hides the base). Whenever the range is non-empty, `range.commits[0]` is therefore the head branch's tip commit. Its `summary` is the subject. `useCreatePrForm` adds one effect plus a `titleSeededRef`: once `range.commits[0]` exists, if the ref is unset and `title` is empty, it calls `setTitle(summary)`. The ref is set the first time a range arrives, whether or not the title was filled, so a title the user typed or cleared is never touched again.

- **Seed once rather than follow retargets:** the head tip does not depend on the base, so following retargets would only matter when the range is empty. In that case the title stays empty, which the spec requires.
- **Over a new "tip subject" command or a `BranchInfo.tipSummary` field:** the commits are already loaded for the commits panel, so a new read would be an extra IPC round trip for data the form already has.
- **Over GitHub's rule** (one commit: its subject; several: the branch name): the user asked for the last commit's title. GitHub's rule would put "feature/PIS-1845" in the title, and the branch name is already shown in the header.

## Risks / Trade-offs

- **[Does React 19 route "Maximum update depth exceeded" through boundaries?]** Checked empirically (task 4.4) with React 19.3 under happy-dom. The old unstable selector, mounted inside `OverlayBoundary` with the Bitbucket token fixture, produced the error card, and `onCaughtError` received "Maximum update depth exceeded…". `render` did not throw, so the error was not uncaught. The overlay boundary alone would therefore have contained the original crash to a closable card. The selector fix is still the cure, and the regression test guards it. The boundary is a working second line, not just a hope.
- **[Error text can carry sensitive paths or names]** Repo paths and branch names land in the log. → The file is local, per user and size-capped. URL credentials are redacted in Rust before writing, and tokens never exist in JS. The decisions doc gets a note.
- **[The registry adds indirection to `AppOverlays`]** → It is still one file and one list. A test asserts every entry renders inside a boundary, so a newly added overlay can't silently skip it.
- **[Calling `prAccountRef()` twice per accounts-store change]** It is cheap, synchronous, keychain-free work. Acceptable.
- **[Card above a half-open overlay's backdrop]** If the overlay crashed after its own `ModalFrame` mounted, React removes the failed subtree first, so the card never stacks over a stale backdrop.

## Migration Plan

This is a frontend and Rust change that ships in a normal release. There is no data migration. The log file is created on the first error. Rollback is a revert, and an orphaned `frontend-errors.log` is harmless.

## Open Questions

- Bitbucket's OAuth-token account carries `login = "x-token-auth"` (the transport sentinel), so the label would read "Opening as x-token-auth". That is today's behaviour on the token path and does not affect this fix. Leave it for a separate label change.
