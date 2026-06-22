import { describe, it, expect } from "vitest";
import { buildXtermTheme } from "./xtermTheme";

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
      }),
    );
    expect(theme.background).toBe("#13151a");
    expect(theme.foreground).toBe("#e6e9ef");
    expect(theme.cursor).toBe("#e6e9ef");
    expect(theme.cursorAccent).toBe("#13151a");
    expect(theme.selectionBackground).toBe("#3a4252");
    expect(theme.brightBlack).toBe("#5a6273");
  });

  it("follows the resolver for a light palette", () => {
    const theme = buildXtermTheme(
      resolver({
        "--code": "#ffffff",
        "--text": "#1a1a1a",
        "--tabActiveBd": "#cccccc",
        "--text4": "#888888",
      }),
    );
    expect(theme.background).toBe("#ffffff");
    expect(theme.foreground).toBe("#1a1a1a");
    expect(theme.selectionBackground).toBe("#cccccc");
    expect(theme.brightBlack).toBe("#888888");
  });

  it("uses the per-key fallbacks when variables are unset", () => {
    // An unset var resolves to its fallback (as the DOM wrapper's `|| fallback` does).
    const theme = buildXtermTheme((_name, fallback) => fallback);
    expect(theme.background).toBe("#13151a");
    expect(theme.foreground).toBe("#e6e9ef");
    expect(theme.selectionBackground).toBe("#3a4252");
    expect(theme.black).toBe("#101217"); // distinct fallback from background
    expect(theme.brightBlack).toBe("#5a6273");
  });

  it("pins the ANSI accent colors to the brand palette regardless of theme", () => {
    const theme = buildXtermTheme(() => "#whatever");
    expect(theme.green).toBe("#2f9e7e");
    expect(theme.brightGreen).toBe("#39d98a");
    expect(theme.red).toBe("#d95454");
    expect(theme.brightRed).toBe("#ff5f6d");
  });
});
