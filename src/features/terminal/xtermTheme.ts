// xterm.js takes concrete color strings (not CSS vars), so the terminal's theme
// is derived from the app's live theme variables. `buildXtermTheme` is the pure
// mapping (var name → theme key, with fallbacks); `xtermTheme` is the thin DOM
// wrapper that reads them off a live element so the terminal follows the active
// `.gp-root`/`.gp-light` palette.
//
// xterm's DOM renderer injects a `<style>` sheet for ANSI classes, cursor, and
// selection. Our CSP (`style-src 'self'`, no `'unsafe-inline'`) blocks that, so
// `applyXtermThemeVars` copies the palette onto the pane as CSS custom
// properties (style *attributes*, which `style-src-attr` allows) and
// `xtermAnsi.css` maps `.xterm-fg-N` / `.xterm-bg-N` onto those variables.
// Accent hues stay fixed (legible on both light and dark); black/white follow
// the theme so ANSI white is not invisible on a light surface.

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
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** ANSI 0–15 keys in xterm's class-index order (`.xterm-fg-0` = black, …). */
export const XTERM_ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** Pure: map resolved CSS variables to an xterm theme. */
export function buildXtermTheme(v: CssVarResolver): XtermTheme {
  return {
    background: v("--code", "#13151a"),
    foreground: v("--text", "#e6e9ef"),
    cursor: v("--text", "#e6e9ef"),
    cursorAccent: v("--code", "#13151a"),
    selectionBackground: v("--tabActiveBd", "#3a4252"),
    // True black, not the surface (`--code` is white in light theme).
    black: "#1a1d23",
    red: "#d95454",
    green: "#2f9e7e",
    yellow: "#b8860b",
    blue: "#3d7cc9",
    magenta: "#b455b4",
    cyan: "#1a9fb0",
    white: v("--text", "#e6e9ef"),
    brightBlack: v("--text4", "#5a6273"),
    brightRed: "#ff5f6d",
    brightGreen: "#39d98a",
    brightYellow: "#d4a017",
    brightBlue: "#5b9bd5",
    brightMagenta: "#c678dd",
    brightCyan: "#3dccd9",
    brightWhite: v("--textBright", "#f3f5f8"),
  };
}

/** Derive the xterm theme from an element's computed CSS variables. */
export function xtermTheme(el: HTMLElement): XtermTheme {
  const cs = getComputedStyle(el);
  return buildXtermTheme((name, fallback) => cs.getPropertyValue(name).trim() || fallback);
}

/** Anything that can take CSS custom properties (the pane mount, or a test stub). */
export interface CssVarHost {
  style: { setProperty(name: string, value: string | null, priority?: string): void };
}

/** Copy the theme onto `el` as CSS custom properties that `xtermAnsi.css` reads.
 *  Style attributes survive CSP; xterm's injected `<style>` sheet does not. */
export function applyXtermThemeVars(el: CssVarHost, theme: XtermTheme): void {
  el.style.setProperty("--gl-term-fg", theme.foreground);
  el.style.setProperty("--gl-term-bg", theme.background);
  el.style.setProperty("--gl-term-cursor", theme.cursor);
  el.style.setProperty("--gl-term-cursor-accent", theme.cursorAccent);
  el.style.setProperty("--gl-term-selection", theme.selectionBackground);
  XTERM_ANSI_KEYS.forEach((key, i) => {
    el.style.setProperty(`--gl-term-${i}`, theme[key]);
  });
}
