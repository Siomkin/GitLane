import { useEffect, useRef, type RefObject } from "react";

/**
 * Dismiss a transient surface (dropdown, popover) on outside mousedown or the
 * Escape key. No-ops while `open` is false. Pass the wrapper element's ref —
 * mousedowns inside it are ignored.
 *
 * `onClose` is read through a ref, so the listener effect only re-subscribes
 * when `open` flips (passing an inline `() => setOpen(false)` is fine).
 */
export function useDismiss(
  open: boolean,
  onClose: () => void,
  ref: RefObject<HTMLElement | null>,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    };
    // Capture Escape so it dismisses this surface *first* and doesn't also reach a
    // parent's Escape handler (e.g. a popover inside a modal closes the popover,
    // not the whole modal).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, ref]);
}
