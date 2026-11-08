# Tasks

## 1. Store: windows, closing list and pause fix

- [x] 1.1 In `src/store/notifications.ts`, replace `defaultDuration` so progress returns `null`, error 12 s, a toast with actions 10 s, warning 8 s and everything else 5 s, with an explicit `duration` still winning. Verify: updated `notifications.test.ts` cases cover each window and replace the old "persists errors, progress, and actionable toasts" case with one where only progress persists.
- [x] 1.2 Add the exported `LeavingToast` type, the `leaving` state and `EXIT_MS = 320`. Make `dismiss` move the toast into `leaving` and remove it after `EXIT_MS`; make `dismissAll` clear it. Verify: a new store test sees the toast leave `toasts` at once, sit in `leaving`, and be gone after 320 ms.
- [x] 1.3 Clear `paused` in `dismiss` when `toasts` becomes empty, and always in `dismissAll`. Verify: a new store test pauses, dismisses the only toast, notifies again and sees the new toast close after 5 s without a resume.
- [x] 1.4 Update the file header comment and the `NotifyInput` doc in `notifications.ts`, and the error comment in `src/store/ui/toasts.ts`, to describe the new policy. Change the legacy forwarder test to expect a 12 s error duration. Verify: `bun run test src/store/notifications.test.ts` passes.

## 2. Toast card and stack

- [x] 2.1 In `notifications/model.ts`, remove `hasAccentBar`, update the `color` doc, and add `withLeaving`; remove the export from `index.ts`. Verify: a new unit test covers order when closes happen first-to-last and last-to-first, plus an index past the end.
- [x] 2.2 In `ToastCard.tsx`, remove the accent strip and countdown bar, layer the inline corner glow over the existing `bg-[var(--elev)]` class, and update the header comment. Verify: a `ToastStack.test.tsx` case asserts neither the strip nor the bar is rendered; the glow itself is checked in a real browser in 3.2, because happy-dom drops `color-mix()` styles.
- [x] 2.3 In `ToastStack.tsx`, render `withLeaving(...)` as keyed `.nf-slot` rows with an inner `div`, setting `data-leaving` and `inert` on closing rows; drop the stack `gap-2.5`; return `null` only when both lists are empty. Reset `leaving` in the test's `beforeEach`. Verify: a new test sees a dismissed card remain marked `data-leaving` and `inert`, and the wrapper unmount once it expires.
- [x] 2.4 In `src/App.css`, add the `.nf-slot` rules with a `prefers-reduced-motion` override, delete the `nf-timer` keyframes and update the section comment. Verify: `grep -rn "nf-timer\|hasAccentBar" src` returns nothing.

- [x] 2.5 In `ToastCard.tsx`, add a thin neutral border alongside `--shadow-pop`, and soften the glow to 7% and the icon circle, so the card separates from the app background without heavy colour. Verify: the card's computed border colour is the same for every kind in a real browser, with screenshots in dark and light.

- [x] 2.6 In `ToastCard.tsx`, keep the original padding, gap and 26 px chip, remove the separate close column, move the chip to the card's right edge, and make it the dismiss button that shows × on card hover or keyboard focus; progress keeps a plain icon. Verify: in a real browser the text column is at least 80% of the card width, hovering a card swaps its icon to ×, and clicking it closes the toast.

## 3. Verification

- [x] 3.1 Run `bun check`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes` and `bun run cycles`. Verify: all exit 0.
- [ ] 3.2 In `bun run tauri dev`, check dark and light themes: the corner glow shows for each kind, closing a middle card fades left and the stack glides, hovering holds a toast, and after closing the last toast under the pointer the next toast closes on its own. Verify: observed in the running app, with a screenshot of the glow.
