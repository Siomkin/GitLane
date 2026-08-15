import { useCallback, useEffect, useState } from "react";

/** Pull a highlight index back inside a list that may have shrunk. Kept in one
 * place so the render-time derivation, the normalization effect, and the arrow
 * stepper can't drift apart. `-1` (no highlight) is preserved. */
export const clampToList = (index: number, length: number) => (index >= length ? length - 1 : index);

/**
 * Arrow-key listbox highlight shared by the combobox-style pickers
 * (`SuggestInput`, `SearchableSelect`). Owns the three things that must not
 * drift apart between copies:
 *
 * - `safeActive` — the highlight clamped to the current list, derived during
 *   render so `aria-activedescendant` / `aria-selected` / the highlight never
 *   point at an option id that isn't rendered on the same frame (a post-paint
 *   effect alone leaves a one-frame gap).
 * - a normalization effect keeping the raw state in range too, so a stale
 *   out-of-range index can't resurface if the list shrinks and later regrows
 *   without user input (e.g. a filter/options refresh while a row is
 *   highlighted).
 * - `onArrowKey(down)` — the wrap-around stepper.
 *
 * `-1` means no highlight: the accessible default until the user actually
 * moves, so Enter can never pick a row the user never arrowed to.
 */
export function useListboxHighlight(length: number) {
  const [active, setActive] = useState(-1);

  const safeActive = clampToList(active, length);

  useEffect(() => {
    setActive((current) => clampToList(current, length));
  }, [length]);

  // From no active row (just opened, or open-but-unhighlighted) ArrowDown
  // lands on the first item and ArrowUp on the last; from an active row it
  // wraps by one. (A plain modulo step from -1 would skip to n-2 on ArrowUp.)
  // Clamp first so a stale index left over from a larger list steps sanely.
  const onArrowKey = useCallback(
    (down: boolean) => {
      setActive((current) => {
        const cur = clampToList(current, length);
        return cur < 0
          ? down
            ? 0
            : length - 1
          : (cur + (down ? 1 : -1) + length) % length;
      });
    },
    [length],
  );

  /** Clear the highlight (`-1`) — on dismiss, or a fresh query. */
  const reset = useCallback(() => setActive(-1), []);

  return { safeActive, setActive, onArrowKey, reset };
}
