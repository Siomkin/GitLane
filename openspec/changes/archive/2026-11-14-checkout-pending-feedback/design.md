# Design

## Context

Engine: unchanged. Checkout stays a git CLI write behind the existing `checkout` / `checkout_remote_branch` commands; this is a frontend-only change in the repo store and the graph ref pills. No IPC layer changes.

Today, in `src/store/repoWriteActions/checkout.ts`:

1. `findCheckoutWorktree` may call `api.listWorktrees` (no feedback, `loading` not yet set).
2. `withCheckoutFeedback` wraps only the git call, showing a progress card after `CHECKOUT_PROGRESS_DELAY_MS` (400 ms).
3. `loading` is released and the card dismissed, then `refreshIfCurrent` reloads summary/graph/branches (no feedback).

`RefPill` fires `checkoutBranch` / `checkoutRemoteBranch` on double-click without checking anything, so a second double-click starts a second checkout. `loading` is only read by the action bar to disable buttons.

## Goals / Non-Goals

**Goals:** one continuous signal from gesture to refreshed history; an immediate in-place signal on the acted-on ref; no double runs.

**Non-Goals:** see proposal. Also: not reusing the global `loading` flag for the pill, since a fetch or other write also sets it.

## Decisions

**1. Store field `checkoutPending: Record<repoPath, ref>` on the repo store.**
Modelled on `fetchingPath`: transient and carried across the same session reset that keeps `fetchingPath` (`repoTypes/data.ts`). Keyed by repo path rather than a single slot, so a checkout started in a second tab while the first is still running cannot erase the first tab's entry (and with it that tab's spinner and re-entry guard). A pill spins when `checkoutPending[summary.path] === name`. The `ref` is the name the user acted on: `name` for `checkoutBranch`, `` `${remote}/${branch}` `` for `checkoutRemoteBranch`, the full sha for detached (no pill matches it; the card names the short sha).
Alternative: component-local state in `RefPill` (like the toolbar's `busy`). Rejected — the context menu, `ActionMenu`, `PrMoreMenu`, the tag/commit menus and reflog recovery call the same actions and would get nothing.

**2. One wrapper owns the whole action.**
`runPendingCheckout` (in `checkoutFeedback.ts`, next to `withCheckoutFeedback`): throws `CheckoutBusyError` if the repo already has an entry (re-entry guard, checked and set synchronously before the first `await`); sets the entry; starts the 400 ms card timer; runs the existing action body (probe → git → refresh); and in `finally` removes the entry and dismisses the card. Checkout actions pass `progress: false` to `withCheckoutFeedback`, which keeps the hook-output card, so there is exactly one progress card per checkout. `createBranchAt`'s checkout is not a ref-pill checkout and keeps `withCheckoutFeedback`'s own card.
The dialog hand-off (`return ""` after `requestConfirm`) and the `openWorktree` paths exit through the same `finally`, so they clear the pending state with no extra code.
Alternative: three separate timers per phase. Rejected — flicker between phases and more code.

**3. Pill rendering.**
`useCheckoutPending(refs)` selects a boolean (`checkoutPending[summary.path]` is one of `refs`) so only the affected pill re-renders. When true it renders `InlineSpinner` (`src/components/ui/Loading.tsx`) instead of `PillGlyph` and sets `aria-busy`. `CombinedRefPill` does the same if its local or any of its remote names match. The double-click handler needs no guard of its own — the store refuses the re-entry and the handler drops `CheckoutBusyError` instead of toasting it.

**4. Refused, not queued.** A second request rejects with `CheckoutBusyError`. A silent `""` was the first plan, but the drag-and-drop menu chains `checkoutRemoteBranch` → `rebaseOnto`, so a silent no-op would let the rebase run without the checkout. `RefPill`'s double-click drops this error; every other caller already toasts rejections, which reads "A checkout is already running".

**Store split / size:** `checkout.ts` is 214 lines, `data.ts` 281, `RefPill.tsx` 83 — all well under the ceiling; no split needed. `ui.ts` is not touched.

## Risks / Trade-offs

- [The slow phase may be the refresh, and refresh can be deferred while `loading` is held] → the wrapper awaits `refreshIfCurrent` as today; if it was deferred the card ends when the action returns. Acceptable; the history updates shortly after via the replayed refresh.
- [A stuck pending state would block all further checkouts in that repo] → removed in `finally` on success, throw and dialog hand-off (all unit-tested). The entry is deliberately carried across tab switches so the guard holds while the git child still runs; the flip side is that a checkout promise that never settles (a hung git) keeps that repo's checkouts refused until the app restarts — the same exposure `fetchingPath` already has.
- [Ignoring a second checkout of a *different* ref could look unresponsive] → the first ref's spinner and the card make it clear something is running.

## Open Questions

- Which phase actually takes the several seconds in the user's report (probe, git/hook, or refresh) is not measured. It does not change the approach — the indicator spans all three — but a quick timing log during implementation would tell whether a separate performance ticket is worth filing.
