import { describe, expect, it } from "vitest";

import { resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("returns explicit preferences unchanged, ignoring the OS", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("follows the OS preference when set to system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("falls back to dark for a corrupt/legacy persisted value", () => {
    // A hand-edited or future localStorage value must never strand the app in an
    // unstyled (light-by-accident) state.
    expect(resolveTheme("nonsense" as unknown as "dark", false)).toBe("dark");
    expect(resolveTheme("" as unknown as "dark", true)).toBe("dark");
  });
});
