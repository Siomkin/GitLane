export type LeftTab = "history" | "changes" | "pulls";

/** Keyboard-only focus ring (focus-visible, so mouse clicks show nothing).
 * Inset so it stays visible inside overflow-hidden rows and menus. */
export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--accent)]";

export const control =
  "min-h-8 cursor-pointer rounded-lg border border-black/10 px-3 text-[13px] font-medium text-neutral-700 transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5";

export const primaryControl =
  "min-h-8 cursor-pointer rounded-lg bg-[var(--accent)] px-3 text-[13px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45";

export const eyebrow =
  "text-[11px] font-semibold uppercase tracking-wider text-neutral-400";

export const panelHeading = "text-[16px] font-semibold leading-tight text-neutral-800 dark:text-neutral-100";
