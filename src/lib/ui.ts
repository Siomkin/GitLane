export type LeftTab = "history" | "changes" | "pulls";

/** Right inspector panel tabs: contextual details vs the repository Files browser. */
export type RightTab = "details" | "files";

/** Shared monospace stack for diffs and the terminal. Lists a preferred face per
 *  platform so each OS renders its native programming font before the generic
 *  fallback: SF Mono/Menlo (macOS), Cascadia Code/Segoe UI Mono/Consolas
 *  (Windows), DejaVu/Liberation (Linux). */
export const MONO_FONT =
  "ui-monospace, 'SF Mono', 'Cascadia Code', 'Segoe UI Mono', Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace";

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

/** 1–2 letter avatar initials from an author's display name. Splits on any
 * whitespace, drops empties, takes the first letter of the first two words,
 * uppercased. Returns "" for an empty/blank name. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}
