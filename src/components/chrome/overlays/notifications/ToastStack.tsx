// The bottom-left toast stack (adapted from Notifications.dc.html, which anchors
// bottom-right — moved left to stay clear of the right-hand inspector panel).
// Newest sits at the bottom, nearest the corner. Countdowns freeze while the
// user is on the stack (pointer, keyboard focus, a text selection in a card) or
// away from the app, so a toast never slips away unread. The wrapper is
// pointer-events-none so it never eats clicks on the app behind it — each card
// re-enables pointer events for itself.

import { useEffect, useRef } from "react";

import { useNotifications } from "@/store/notifications";
import { ToastCard } from "./ToastCard";
import { withLeaving } from "./model";

export function Toasts() {
  const toasts = useNotifications((s) => s.toasts);
  const leaving = useNotifications((s) => s.leaving);
  const paused = useNotifications((s) => s.paused);
  const pauseTimers = useNotifications((s) => s.pauseTimers);
  const resumeTimers = useNotifications((s) => s.resumeTimers);
  const stack = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const syncWindow = () => {
      if (document.hasFocus() && !document.hidden) resumeTimers("window");
      else pauseTimers("window");
    };
    const syncSelection = () => {
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed && stack.current?.contains(selection.anchorNode)) {
        pauseTimers("selection");
      } else {
        resumeTimers("selection");
      }
    };
    window.addEventListener("focus", syncWindow);
    window.addEventListener("blur", syncWindow);
    document.addEventListener("visibilitychange", syncWindow);
    document.addEventListener("selectionchange", syncSelection);
    return () => {
      window.removeEventListener("focus", syncWindow);
      window.removeEventListener("blur", syncWindow);
      document.removeEventListener("visibilitychange", syncWindow);
      document.removeEventListener("selectionchange", syncSelection);
      // Unmounting sends no mouseleave or blur, so end every hold this stack set.
      resumeTimers("window");
      resumeTimers("selection");
      resumeTimers("pointer");
      resumeTimers("focus");
    };
  }, [pauseTimers, resumeTimers]);

  // A focused card that closes never reports a blur, so check after every change.
  useEffect(() => {
    if (!stack.current?.contains(document.activeElement)) resumeTimers("focus");
  }, [toasts, leaving, resumeTimers]);

  if (toasts.length === 0 && leaving.length === 0) return null;

  return (
    <div
      ref={stack}
      className="pointer-events-none fixed bottom-6 left-6 z-[70] flex w-[340px] max-w-[calc(100vw-32px)] flex-col items-start"
      // Real movement only: a card appearing under a resting pointer fires mouseenter too.
      onMouseMove={(e) => {
        if (e.movementX !== 0 || e.movementY !== 0) pauseTimers("pointer");
      }}
      onMouseLeave={() => resumeTimers("pointer")}
      onFocus={() => pauseTimers("focus")}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) resumeTimers("focus");
      }}
    >
      {withLeaving(toasts, leaving).map(({ toast, leaving: isLeaving }) => (
        <div key={toast.id} className="nf-slot" data-leaving={isLeaving || undefined} inert={isLeaving}>
          <div>
            <ToastCard toast={toast} paused={paused} />
          </div>
        </div>
      ))}
    </div>
  );
}
