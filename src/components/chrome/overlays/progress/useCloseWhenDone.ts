import { useEffect, useRef } from "react";

/** How long a finished step dialog shows its ticked list before it closes. */
export const DONE_CLOSE_MS = 1200;

/** Success needs no reading: once `done`, move focus to the returned close
 *  button (so keyboard users aren't stranded) and close after `DONE_CLOSE_MS`. */
export function useCloseWhenDone(done: boolean, close: () => void) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!done) return;
    closeRef.current?.focus();
    const timer = setTimeout(close, DONE_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [done, close]);
  return closeRef;
}
