# Proposal

## Why

On a repository whose pull requests go through a GitLane-owned keychain token, "Open a pull request…" blanks the whole window. That covers Bitbucket, and GitLab when glab can't serve the host. Reproduced on release v2.3.11.

The create-PR form subscribes to `useAccounts((s) => s.prAccountRef())`, and for those forges `prAccountRef()` builds a new object on every call. Under Zustand 5 and React 19's `useSyncExternalStore`, an unstable snapshot re-renders without end. `CreatePrDialog` is mounted in `AppOverlays`, which no error boundary covers, so React unmounts the root. The user is left with the bare `#bdb8b0` page background. Release builds have no devtools and the root has no error hook, so the crash leaves no trace anywhere.

Jira: no GL issue yet. Add the key to the branch, commit and PR if one is filed.

## What Changes

- **Selector fix**: the create-PR form subscribes only to the primitive fields it shows (login and host), never to a freshly built account object. The submit path keeps reading `prAccountRef()` through `getState()` at call time, as `pulls/writes.ts` already does.
- **Regression test**: render the create-PR dialog with a Bitbucket forge plus a stored provider token, and with a GitLab forge plus a token and no glab. Assert that it renders "Opening as <login>" and settles.
- **Title prefill**: when the dialog opens with an empty title, it fills the title with the subject of the head branch's last commit once that commit is known. It never overwrites text the user typed or cleared. This is a small usability addition that rides on the same dialog work, and it needs no new IPC because the commits read already returns the head's newest commit first.
- **Overlay containment**: each globally mounted overlay renders inside its own error boundary. The PRs-mode list (`LeftPanel`) gets one too. A crashing dialog or menu then shows a dismissable error card instead of taking the window down, and dismissing it closes that overlay.
- **Last-resort root fallback**: a boundary around `<App />` shows "GitLane hit an error" with Reload in place of a blank window, for anything the narrower boundaries miss.
- **Error trace**: `createRoot` gets `onUncaughtError` and `onCaughtError` handlers. Each forwards the error message, stack and component stack, secret-redacted, to a new `report_frontend_error` command. The command appends the entry to a size-capped log file in the OS app-log directory, so release builds leave a trace.

## Capabilities

### New Capabilities

- `pull-requests/create`: the create-PR dialog opens and stays usable on every forge whose PR account resolves through a GitLane-owned token, and its title starts as the head branch's last commit subject. The `openspec/specs/pull-requests/` area has no create capability today; `detail` covers an existing PR.

### Modified Capabilities

- `chrome/overlays`: adds crash-containment requirements. A failing overlay or PR-list panel shows a recoverable fallback, the window is never left blank, and frontend render errors are recorded to a local log.

## Non-goals

- No audit-wide rewrite of store selectors. One grep sweep for the same "selector calls a function that returns an object" pattern is in scope, and the sweep only fixes what it finds.
- No change to how `prAccountRef()` resolves accounts and no change to account binding.
- No `tauri-plugin-log`: it stays Deferred in `docs/tauri-plugin-decisions.md`. The log is one append-only file written by one command.
- No telemetry and no network upload. The log stays on the user's machine.
- No capture of `window.onerror` or `unhandledrejection` beyond what React's root hooks report.
- No GitHub-style title rule (branch name when there are several commits) and no prefill of the description. "From commits" and templates stay explicit actions.
- No redesign of `ErrorFallback` and no boundaries around the title bar or action bar beyond what the root fallback already covers.

## Impact

- **Processes**: frontend and Rust, plus one new IPC command.
- **Frontend**:
  - `src/features/pull-requests/create-pr/useCreatePrForm.ts` and a new create-PR test file.
  - `src/app-shell/AppOverlays.tsx` and `src/App.tsx` for the `LeftPanel` boundary.
  - `src/main.tsx` for the root hooks and the root fallback.
  - `src/lib/api/` for the new wrapper.
- **Rust**: a new diagnostics module that writes the log file, `commands/diagnostics.rs`, and the registration line in `lib.rs`.
- **Code to copy**:
  - `components/ui/ErrorBoundary.tsx` and `ErrorFallback.tsx`, already used by `CenterWorkspace` and the terminal layer.
  - `redact::redact_secrets` for scrubbing.
  - `commands/auth.rs`, which resolves the app-data dir in the command layer and passes it to the module that writes the file.
- **Secrets, auth and IPC risk**:
  - The new command carries error text, not credentials, but error messages can echo a remote URL. Rust runs `redact_secrets` before writing.
  - The command declares no credential parameter, which the registration tests already enforce.
  - Provider tokens stay in Rust. The selector fix moves account data further out of reactive JS state, not into it.
