export type LeftTab = "history" | "changes" | "pulls";

/** Right inspector panel tabs: contextual details vs the repository Files browser. */
export type RightTab = "details" | "files";

/** How a changed-files list is laid out: a flat repo-relative **Path** list, or
 * a collapsible directory **Tree**. A view preference shared across the changed-
 * files inspectors and the stacked "review all" ordering, so it lives here (not
 * in a feature) where the ui store can own it without importing from features.
 *
 * Single source of truth for the two values — reference `FileListView.Path` /
 * `FileListView.Tree` rather than bare `"path"` / `"tree"` literals so a typo
 * fails to compile and a rename is one edit. */
export const FileListView = {
  Path: "path",
  Tree: "tree",
} as const;
export type FileListView = (typeof FileListView)[keyof typeof FileListView];

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

/** Gap between the floating terminal and the window/workspace edges. Matches the
 * workspace shell's `px-2.5 pb-2.5` (10px) so the terminal's edges line up with
 * the workspace blocks. Lives here (not in the terminal feature) because the ui
 * store's inset clamp needs the same floor without importing from features. */
export const TERMINAL_EDGE_MARGIN = 10;

/** Floating-terminal height clamps — shared by the ui store's setters and the
 * terminal feature's drag geometry so they can't drift apart. */
export const TERMINAL_MIN_HEIGHT = 160;
export const TERMINAL_MAX_HEIGHT = 860;

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
