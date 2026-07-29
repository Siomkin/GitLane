import { useRef, type MouseEvent as ReactMouseEvent } from "react";

/**
 * Handlers for a modal's full-screen backdrop that make "click the backdrop to
 * dismiss" survive a drag that starts inside the panel.
 *
 * A text selection dragged out of a field (press inside the panel, release on
 * the backdrop) dispatches its click on the *common ancestor* — the backdrop —
 * so the panel's `stopPropagation` never sees it and the dialog closed
 * mid-selection. Remembering where the press landed lets the click dismiss only
 * when it didn't start inside the panel.
 *
 * A click with no preceding mousedown (synthetic events, AT-generated clicks)
 * leaves the flag false and still dismisses.
 *
 * The dismiss callback is passed to `onClick(fn)` at render rather than to the
 * hook, so callers whose dismissal depends on state computed after an early
 * return (`phase === "running" ? undefined : close`) can still call the hook
 * unconditionally at the top of the component.
 *
 *     const backdrop = useBackdropDismiss();
 *     <div onMouseDown={backdrop.onMouseDown} onClick={backdrop.onClick(close)} />
 */
export function useBackdropDismiss() {
  // True when the press landed on a descendant (the panel) rather than on the
  // backdrop element itself.
  const pressedInside = useRef(false);
  return {
    onMouseDown: (e: ReactMouseEvent) => {
      pressedInside.current = e.target !== e.currentTarget;
    },
    /** Backdrop onClick for `dismiss`; pass `undefined` while dismissal is
     * blocked (e.g. an operation is running) and the click does nothing. */
    onClick: (dismiss: (() => void) | undefined) => () => {
      // Consume the flag: it describes the press this click belongs to, and a
      // later click that arrives without a press of its own (synthetic, AT) must
      // not inherit it. Cleared even when dismissal is blocked, so the flag never
      // outlives the interaction that set it.
      const pressStartedInside = pressedInside.current;
      pressedInside.current = false;
      if (!pressStartedInside) dismiss?.();
    },
  };
}
