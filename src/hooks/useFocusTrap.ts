import { useEffect, type RefObject } from "react";

/** Focusable descendants, in DOM order, that Tab can reach. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Trap keyboard focus inside a modal surface while `active`, so keyboard and
 * screen-reader users can't Tab out to the inert content behind it — the piece
 * `role="dialog"` alone doesn't provide. This is the tested, jsdom-friendly
 * alternative to a native `<dialog>`/`showModal()` (unimplemented in jsdom), and
 * it deliberately leaves *dismissal* (Escape, backdrop click) to each dialog's
 * own wiring so their guards stay in control — e.g. the hand-off dialog's
 * mid-run block and Settings' nested-overlay suspension.
 *
 * On activation it moves focus inside only if it isn't already there, so a
 * child's `autoFocus` (React focuses it during commit, before this effect runs)
 * keeps ownership of the initial target. On deactivation it restores focus to
 * whatever was focused before the dialog opened.
 *
 * jsdom has no layout, so visibility can't be probed via `offsetParent`; the
 * modals here mount their focusables conditionally (not `display:none`), so
 * "present in the DOM" is a sound proxy for "focusable".
 */
export function useFocusTrap(active: boolean, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const container = ref.current;
    if (!active || !container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));

    // Seed focus only when nothing inside already has it (honours a child's autoFocus).
    if (!container.contains(document.activeElement)) {
      (focusables()[0] ?? container).focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        // Nothing to cycle through — keep focus pinned to the container.
        e.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const el = document.activeElement;
      if (e.shiftKey) {
        if (el === first || !container.contains(el)) {
          e.preventDefault();
          last.focus();
        }
      } else if (el === last || !container.contains(el)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [active, ref]);
}
