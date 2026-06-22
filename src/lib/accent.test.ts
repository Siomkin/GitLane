import { describe, expect, it } from "vitest";

import { ACCENTS, accentHex, accentVars, type AccentColor } from "./accent";

describe("accent palette", () => {
  it("keeps the design's canonical hexes for the original six", () => {
    expect(accentHex("green")).toBe("#2e9e62");
    expect(accentHex("blue")).toBe("#3b7ff5");
    expect(accentHex("purple")).toBe("#7a5af0");
    expect(accentHex("teal")).toBe("#0e9b8a");
    expect(accentHex("orange")).toBe("#e07b39");
    expect(accentHex("pink")).toBe("#db4d8a");
  });

  it("falls back to green for an unknown accent", () => {
    expect(accentHex("nope" as AccentColor)).toBe("#2e9e62");
  });

  it("has unique ids and hexes", () => {
    const ids = ACCENTS.map((a) => a.id);
    const hexes = ACCENTS.map((a) => a.hex);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(hexes).size).toBe(hexes.length);
  });

  it("derives --accent-soft from the hex, with a stronger wash in dark mode", () => {
    expect(accentVars("green", false)).toEqual({
      "--accent": "#2e9e62",
      "--accent-soft": "rgba(46, 158, 98, 0.13)",
    });
    expect(accentVars("green", true)).toEqual({
      "--accent": "#2e9e62",
      "--accent-soft": "rgba(46, 158, 98, 0.2)",
    });
  });

  it("produces a valid rgba soft wash for every accent, keyed to mode", () => {
    for (const accent of ACCENTS) {
      const light = accentVars(accent.id, false) as Record<string, string>;
      const dark = accentVars(accent.id, true) as Record<string, string>;
      expect(light["--accent"]).toBe(accent.hex);
      expect(light["--accent-soft"]).toMatch(/^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.13\)$/);
      expect(dark["--accent-soft"]).toMatch(/^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.2\)$/);
    }
  });
});
