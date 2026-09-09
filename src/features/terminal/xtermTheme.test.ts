import { describe, it, expect } from "vitest";
import { applyXtermThemeVars, buildXtermTheme, XTERM_ANSI_KEYS } from "./xtermTheme";

const resolver =
  (vars: Record<string, string>) =>
  (name: string, fallback: string) =>
    vars[name] ?? fallback;

describe("buildXtermTheme", () => {
  it("maps a dark palette onto the xterm theme keys", () => {
    const theme = buildXtermTheme(
      resolver({
        "--code": "#13151a",
        "--text": "#e6e9ef",
        "--tabActiveBd": "#3a4252",
        "--text4": "#5a6273",
        "--textBright": "#f3f5f8",
      }),
    );
    expect(theme.background).toBe("#13151a");
    expect(theme.foreground).toBe("#e6e9ef");
    expect(theme.cursor).toBe("#e6e9ef");
    expect(theme.cursorAccent).toBe("#13151a");
    expect(theme.selectionBackground).toBe("#3a4252");
    expect(theme.white).toBe("#e6e9ef");
    expect(theme.brightBlack).toBe("#5a6273");
    expect(theme.brightWhite).toBe("#f3f5f8");
  });

  it("follows the resolver for a light palette, keeping ANSI black dark", () => {
    const theme = buildXtermTheme(
      resolver({
        "--code": "#ffffff",
        "--text": "#1a1a1a",
        "--tabActiveBd": "#cccccc",
        "--text4": "#888888",
        "--textBright": "#0d1117",
      }),
    );
    expect(theme.background).toBe("#ffffff");
    expect(theme.foreground).toBe("#1a1a1a");
    expect(theme.selectionBackground).toBe("#cccccc");
    expect(theme.black).toBe("#1a1d23");
    expect(theme.white).toBe("#1a1a1a");
    expect(theme.brightBlack).toBe("#888888");
    expect(theme.brightWhite).toBe("#0d1117");
  });

  it("uses the per-key fallbacks when variables are unset", () => {
    // An unset var resolves to its fallback (as the DOM wrapper's `|| fallback` does).
    const theme = buildXtermTheme((_name, fallback) => fallback);
    expect(theme.background).toBe("#13151a");
    expect(theme.foreground).toBe("#e6e9ef");
    expect(theme.selectionBackground).toBe("#3a4252");
    expect(theme.black).toBe("#1a1d23");
    expect(theme.brightBlack).toBe("#5a6273");
    expect(theme.white).toBe("#e6e9ef");
  });

  it("pins the ANSI accent colors to the brand palette regardless of theme", () => {
    const theme = buildXtermTheme(() => "#whatever");
    expect(theme.red).toBe("#d95454");
    expect(theme.green).toBe("#2f9e7e");
    expect(theme.yellow).toBe("#b8860b");
    expect(theme.blue).toBe("#3d7cc9");
    expect(theme.magenta).toBe("#b455b4");
    expect(theme.cyan).toBe("#1a9fb0");
    expect(theme.brightRed).toBe("#ff5f6d");
    expect(theme.brightGreen).toBe("#39d98a");
    expect(theme.brightYellow).toBe("#d4a017");
    expect(theme.brightBlue).toBe("#5b9bd5");
    expect(theme.brightMagenta).toBe("#c678dd");
    expect(theme.brightCyan).toBe("#3dccd9");
  });
});

describe("applyXtermThemeVars", () => {
  it("writes chrome and ANSI 0–15 as CSS custom properties on the pane", () => {
    const vars: Record<string, string> = {};
    const el = {
      style: {
        setProperty(name: string, value: string | null) {
          if (value === null) delete vars[name];
          else vars[name] = value;
        },
      },
    };
    const theme = buildXtermTheme(
      resolver({
        "--code": "#13151a",
        "--text": "#e6e9ef",
        "--tabActiveBd": "#3a4252",
        "--text4": "#5a6273",
        "--textBright": "#f3f5f8",
      }),
    );
    applyXtermThemeVars(el, theme);
    expect(vars["--gl-term-fg"]).toBe("#e6e9ef");
    expect(vars["--gl-term-bg"]).toBe("#13151a");
    expect(vars["--gl-term-cursor"]).toBe("#e6e9ef");
    expect(vars["--gl-term-selection"]).toBe("#3a4252");
    expect(XTERM_ANSI_KEYS).toHaveLength(16);
    XTERM_ANSI_KEYS.forEach((key, i) => {
      expect(vars[`--gl-term-${i}`]).toBe(theme[key]);
    });
  });
});
