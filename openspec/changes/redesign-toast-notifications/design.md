# Design

## Context

Toasts live in the `useNotifications` Zustand store (`src/store/notifications.ts`) and render through `Toasts` and `ToastCard` in `src/components/chrome/overlays/notifications/`. No git engine or IPC command is involved, and no new store or dependency is needed.

Three facts in the current code shape the approach:

- `dismiss` removes a toast from `toasts` synchronously, so a card has no chance to animate. Timers, tests and callers all rely on that synchronous removal.
- `Toasts` returns `null` when the list is empty. Removing the last card under the pointer unmounts the wrapper, the browser fires no `mouseleave`, and `paused` stays `true`. `scheduleTimer` then stores every later toast as frozen.
- All `showToast(_, "error")` calls use `raw: true`, so "keep long errors open" would be the same as "keep every error open". Errors therefore get one window.

Callers that set their own duration keep it: the push success card (5 s) and checkout output (15 s).

## Goals / Non-Goals

**Goals:** animate every normal close without changing what `toasts` means to existing code, and make a stuck pause impossible.

**Non-Goals:** a generic animation library or presence component for other overlays. See also the proposal's non-goals.

## Decisions

**Store a separate `leaving` list instead of a flag on each toast.** `dismiss` still removes the toast from `toasts` at once and appends `{ toast, index }` to a render-only `leaving` list, which drops the entry after 320 ms. Existing callers and timer tests keep their meaning. A `leaving` flag inside `toasts` was rejected because every "is it gone" assertion and the stack-limit count would have to learn about it. Retaining removed cards inside React was rejected because diffing previous props for order and timeouts is more code, and it would split toast lifecycle between the store and the view.

**Merge in a pure helper.** `withLeaving(toasts, leaving)` in `model.ts` re-inserts closing cards at their old positions, latest-dismissed first, because each saved `index` was taken after earlier closes. Rows are keyed by toast id, so React keeps the same DOM node when a card moves between the lists and the CSS transition runs on it.

**Animate with CSS on a slot wrapper.** Each card sits in a `.nf-slot` grid with an inner clipping `div`. Closing sets `data-leaving`: the card fades and moves 18 px left over about 180 ms, then the row transitions from `1fr` to `0fr` after a 100 ms delay. The slot's top padding replaces the stack's `gap`, because a flex gap cannot collapse. The inner `div` clips only while leaving, so the card shadow is otherwise visible. `prefers-reduced-motion` turns the transitions off. A closing slot gets the `inert` attribute, supported by React 19, which covers both clicks and assistive technology.

**End the pause in the store.** `dismiss` sets `paused` to `false` when `toasts` becomes empty, and `dismissAll` always clears it. This fixes the cause in one place. An unmount effect in `Toasts` was rejected because the wrapper now stays mounted during the exit animation, and the state belongs to the store.

**Corner glow from the existing status colours.** `ToastCard` sets an inline `radial-gradient(100% 120% at 0 0, color-mix(in srgb, <status> 7%, var(--elev)), var(--elev) 55%)`, using the `color` already in `KIND_VISUAL`. The tokens are already themed, so no new CSS variables are needed.

**Separate the card from the page.** The glow alone left the card hard to tell from the main background, because `--border` nearly matches it and `--shadow-pop` barely shows on dark. The card gets a neutral hairline: 10% black in light, 10% white in dark. Status-tinted borders were tried at 42% and 20%; together with the glow and icon circle they read as cartoonish, so colour is kept to a faint 7% glow and the icon. `--shadow-pop` itself is shared with other overlays, so it stays unchanged.

**Give the text the width.** The icon column, gaps and a full-height close column left the text about 70% of the card. The status chip moves to the card's right edge and doubles as the dismiss button, so one column replaces two and the text gets 80% of the card at the original padding, gap and chip size. Tighter padding and a smaller chip were tried and rejected as cramped. The swap to × uses Tailwind group variants on the card (hover) and the button (`focus-visible`), so it needs no state and stays reachable by keyboard. A corner-pinned × with a float spacer in the title was tried first; it left the first line short and could overlap a scrolled `raw` title.

**Remove the accent strip and countdown bar outright.** `hasAccentBar`, its export, the `nf-timer` keyframes and the `showTimer` block go away. The `paused` prop stays because the indeterminate progress sweep still uses it.

**Size.** `notifications.ts` is 242 lines and grows by about 30, which stays within the 400-line ceiling and needs no split.

## Risks / Trade-offs

- [An error can close before it is read, and there is no history] → It stays 12 s, longest of all kinds, and hovering holds it. The user accepted this trade-off.
- [A toast action such as "Fix authentication…" disappears with its error] → The same hold applies. The failed operation can be repeated to raise the toast again.
- [A card dropped by the four-card limit vanishes without animation] → Rare, and intentionally out of scope.
- [Timeout and CSS durations are two separate numbers] → They are kept together by a comment on `EXIT_MS` naming `.nf-slot`. If they drift, the worst case is a clipped or slightly lingering invisible card.
