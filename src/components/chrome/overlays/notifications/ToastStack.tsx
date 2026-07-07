// The bottom-left toast stack (adapted from Notifications.dc.html, which anchors
// bottom-right — moved left to stay clear of the right-hand inspector panel).
// Newest sits at the bottom, nearest the corner; hovering anywhere over the
// stack pauses every countdown so the user can read/act before a toast slips
// away. The wrapper is pointer-events-none so it never eats clicks on the app
// behind it — each card re-enables pointer events for itself.

import { useNotifications } from "@/store/notifications";
import { ToastCard } from "./ToastCard";

export function Toasts() {
  const toasts = useNotifications((s) => s.toasts);
  const paused = useNotifications((s) => s.paused);
  const pauseTimers = useNotifications((s) => s.pauseTimers);
  const resumeTimers = useNotifications((s) => s.resumeTimers);

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-6 left-6 z-[70] flex w-[340px] max-w-[calc(100vw-32px)] flex-col items-start gap-2.5"
      onMouseEnter={pauseTimers}
      onMouseLeave={resumeTimers}
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} paused={paused} />
      ))}
    </div>
  );
}
