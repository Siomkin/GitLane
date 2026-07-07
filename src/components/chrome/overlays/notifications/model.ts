// Pure view-model helpers for the toast stack — kind → colour tokens and the
// small structural rules the card renders by. No React, no store.

import type { NotifyKind } from "@/store/notifications";

export interface KindVisual {
  /** CSS var for the stroke/text (icon + accent bar) colour. */
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

/** Every kind carries the 3px left accent bar except progress, whose fill
 *  track already reads as the accent (design: no bar on progress cards). */
export function hasAccentBar(kind: NotifyKind): boolean {
  return kind !== "progress";
}
