// Pure view-model helpers for the toast stack — kind → colour tokens and the
// small structural rules the card renders by. No React, no store.

import type { LeavingToast, Notification, NotifyKind } from "@/store/notifications";

export interface KindVisual {
  /** CSS var for the icon colour and the card's corner glow. */
  color: string;
  /** CSS var for the soft chip background behind the icon. */
  soft: string;
}

export const KIND_VISUAL: Record<NotifyKind, KindVisual> = {
  info: { color: "var(--nf-info)", soft: "var(--nf-info-soft)" },
  success: { color: "var(--nf-success)", soft: "var(--nf-success-soft)" },
  warning: { color: "var(--nf-warning)", soft: "var(--nf-warning-soft)" },
  error: { color: "var(--nf-error)", soft: "var(--nf-error-soft)" },
  progress: { color: "var(--nf-success)", soft: "var(--nf-success-soft)" },
  neutral: { color: "var(--nf-neutral)", soft: "var(--nf-neutral-soft)" },
};

/** Live toasts with the cards still animating out put back where they were.
 *  Latest-dismissed first: each `index` was taken with the earlier ones already gone. */
export function withLeaving(toasts: Notification[], leaving: LeavingToast[]) {
  const rows = toasts.map((toast) => ({ toast, leaving: false }));
  for (const l of [...leaving].reverse()) {
    rows.splice(Math.min(l.index, rows.length), 0, { toast: l.toast, leaving: true });
  }
  return rows;
}
