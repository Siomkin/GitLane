// xterm.js takes concrete color strings (not CSS vars), so the terminal's theme
// is derived from the app's live theme variables. `buildXtermTheme` is the pure
// mapping (var name → theme key, with fallbacks); `xtermTheme` is the thin DOM
// wrapper that reads them off a live element so the terminal follows the active
// `.gp-root`/`.gp-light` palette. ANSI accents stay fixed to the brand palette
// (legible on both light and dark).

/** A theme-variable resolver: returns the value for `name`, or `fallback` when
 * the variable is unset/empty. */
export type CssVarResolver = (name: string, fallback: string) => string;

export interface XtermTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  brightBlack: string;
  green: string;
  brightGreen: string;
  red: string;
  brightRed: string;
}

/** Pure: map resolved CSS variables to an xterm theme. */
export function buildXtermTheme(v: CssVarResolver): XtermTheme {
  return {
    background: v("--code", "#13151a"),
    foreground: v("--text", "#e6e9ef"),
    cursor: v("--text", "#e6e9ef"),
    cursorAccent: v("--code", "#13151a"),
    selectionBackground: v("--tabActiveBd", "#3a4252"),
    black: v("--code", "#101217"),
    brightBlack: v("--text4", "#5a6273"),
    green: "#2f9e7e",
    brightGreen: "#39d98a",
    red: "#d95454",
    brightRed: "#ff5f6d",
  };
}

/** Derive the xterm theme from an element's computed CSS variables. */
export function xtermTheme(el: HTMLElement): XtermTheme {
  const cs = getComputedStyle(el);
  return buildXtermTheme((name, fallback) => cs.getPropertyValue(name).trim() || fallback);
}
