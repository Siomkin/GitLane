# Tasks

## 1. Store

- [x] 1.1 Add `checkoutPending: Record<repoPath, ref>` to the repo store data (`src/store/repoTypes/data.ts`), defaulting to `null` and carried through session reset the same way as `fetchingPath`; verify with `bun check`.
- [x] 1.2 In `src/store/repoWriteActions/checkoutFeedback.ts`, add `runPendingCheckout`: synchronous re-entry check on the repo's `checkoutPending` entry (throws `CheckoutBusyError`), set the entry, 400 ms progress card, `finally` removes the entry and dismisses the card. Give `withCheckoutFeedback` a `progress` option so checkout actions turn its own card off and keep its hook-output card; verify `checkoutFeedback.test.ts` still passes.
- [x] 1.3 Wrap `checkoutBranch` (ref = `name`), `checkoutRemoteBranch` (ref = `` `${remote}/${branch}` ``) and `checkoutDetached` (full sha; the card names the short sha) in `src/store/repoWriteActions/checkout.ts` so the probe, git call and `refreshIfCurrent` all run inside it; verify by test 3.1.

## 2. UI

- [x] 2.1 `RefPill.tsx`: select a per-pill boolean for "this ref is pending in this repo"; when true render `InlineSpinner` in place of `PillGlyph` and set `aria-busy="true"`; verify with a render test (3.3).
- [x] 2.2 `CombinedRefPill.tsx`: show the same spinner when the local name or any combined remote name is pending; verify with a render test (3.3).

## 3. Tests

- [x] 3.1 Store tests (`checkoutFeedback.test.ts`, fake timers): card appears after the delay and stays through a slow refresh; no card for a fast checkout + refresh; `checkoutPending` is set immediately and cleared on success, on a thrown git error, and on the worktree-dialog `""` return.
- [x] 3.2 Store test: a second `checkoutBranch` / `checkoutRemoteBranch` while one is pending in the same repo rejects with `CheckoutBusyError` and invokes the checkout command once; a pending checkout in another repo path does not block.
- [x] 3.3 Render tests for `RefPill` / `CombinedRefPill`: spinner and `aria-busy` only on the matching ref and only when the entry is keyed by the open repo's path; a repeat double-click runs git once and shows no error.

## 4. Verify

- [x] 4.1 Run the project `verify` agent (bun check, oxlint, vitest, sizes, cycles); all exit 0.
- [x] 4.2 `bun run tauri dev`: double-click a remote ref in a repository with a slow `post-checkout` hook; the pill spins at once, the card appears after ~400 ms, both clear when the graph shows the new branch; a second double-click during it does nothing.
