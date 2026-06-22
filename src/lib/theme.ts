// Theme preference vs. resolved mode. The user can pick `dark`, `light`, or
// `system`; `system` follows the OS `prefers-color-scheme`. Everything that
// actually paints (the `.dark` class, accent alpha, graph/terminal colours)
// keys off the *resolved* `"dark" | "light"`, never the raw preference.

import type { Theme } from "../store/ui";

/** The media query the whole app keys its system-theme following off. */
export const PREFERS_DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Resolve a stored preference to the concrete mode to paint. `system` follows the
 * OS; an explicit `light` stays light; anything else — including a corrupt or
 * legacy persisted value — falls back to `dark` (the store default) so a tampered
 * `localStorage` can never strand the app in an unstyled state.
 */
export function resolveTheme(theme: Theme, systemDark: boolean): "dark" | "light" {
  if (theme === "light") return "light";
  if (theme === "system") return systemDark ? "dark" : "light";
  return "dark";
}

/** Current OS colour-scheme preference (true = dark). Safe when matchMedia is absent. */
export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(PREFERS_DARK_QUERY).matches
    : false;
}
