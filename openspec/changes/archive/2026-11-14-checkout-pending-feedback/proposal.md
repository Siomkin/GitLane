# Proposal

## Why

Double-clicking a ref pill (for example `origin/develop`) to check it out can take several seconds, and the user cannot tell whether anything is happening. GitLane already shows a "Checking out …" progress card after 400 ms, but only around the git call itself: the worktree probe that runs before git and the repository refresh that runs after it show nothing, and the pill the user clicked never changes. No Jira issue exists for this yet.

## What Changes

- The ref the user acted on shows a pending state (spinner in place of its glyph, `aria-busy`) from the gesture until the checkout has finished and the history has been refreshed, or the checkout has failed or handed off to a dialog.
- The existing progress card covers the whole checkout — worktree probe, git, and the refresh afterwards — instead of only the git call. Its 400 ms delay stays, so fast checkouts still show no card.
- While a checkout is pending in a repository, another checkout request in that repository does not start a second git run: a repeated pill double-click is dropped silently, a menu request reports that a checkout is already running (so an action chained after the checkout, like the drag-and-drop "check out then rebase", never runs without it).
- The pending state is owned by the repo store's checkout actions, so every entry point (double-click on a pill, branch context menu, drag-and-drop action menu, PR "Check out", tag/commit menus, reflog recovery) gets it, not only the double-click.

Process touched: frontend only (Zustand repo store + graph ref pills). No Rust, no IPC change.

## Non-goals

- No change to how checkout itself runs (backend, hook handling, worktree hand-off dialog).
- No per-phase labels ("Probing worktrees…", "Refreshing…") — one "Checking out X…" message is enough.
- No pending state for other write operations (merge, rebase, reset); they can adopt the same pattern later.
- No cancel button for a running checkout.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `history/write-ops`: the "A slow checkout shows a progress indicator" requirement widens to cover the whole checkout including the refresh; new requirements for the in-place pending state on the acted-on ref and for ignoring a second checkout while one is pending.

## Impact

- `src/store/repoWriteActions/checkout.ts`, `checkoutFeedback.ts` — wrap the whole action, set/clear the pending ref.
- `src/store/repoTypes/data.ts` — one new transient field, modelled on `fetchingPath` (path-scoped, so a tab switch cannot leave a stale spinner).
- `src/features/graph/commit-row/RefPill.tsx`, `CombinedRefPill.tsx`, new `useCheckoutPending.ts` — render `InlineSpinner` (`src/components/ui/Loading.tsx`) while pending.
- Existing pattern to copy: `fetchingPath` (path-scoped in-flight flag) and the toolbar's `busyRef` re-entry guard in `useActionBarModel.ts`.
- Secrets/auth/IPC risk: none — no new command, no credential handling, no persisted state.
