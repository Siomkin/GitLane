import { afterEach, describe, expect, it, vi } from "vitest";
import { readMigratedStorage } from "./storage";

const CURRENT = "gitlane.test:v1";
const LEGACY = "gitlane.test";

// A self-contained in-memory Storage stub. Spying on its own-property methods is
// portable across host localStorage implementations (jsdom vs. a native global),
// unlike spying on the shared global's inherited prototype methods.
function installStorage(entries: [string, string][] = []) {
  const map = new Map(entries);
  const storage = {
    getItem: (k: string): string | null => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("readMigratedStorage", () => {
  it("copies a legacy value before deleting its old key", () => {
    const s = installStorage([[LEGACY, "legacy"]]);

    expect(readMigratedStorage(CURRENT, LEGACY)).toBe("legacy");
    expect(s.getItem(CURRENT)).toBe("legacy");
    expect(s.getItem(LEGACY)).toBeNull();
  });

  it("prefers the versioned value and removes stale legacy data", () => {
    const s = installStorage([
      [CURRENT, "current"],
      [LEGACY, "stale"],
    ]);

    expect(readMigratedStorage(CURRENT, LEGACY)).toBe("current");
    expect(s.getItem(LEGACY)).toBeNull();
  });

  it("returns readable legacy data when copying it fails", () => {
    const s = installStorage([[LEGACY, "legacy"]]);
    vi.spyOn(s, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    expect(readMigratedStorage(CURRENT, LEGACY)).toBe("legacy");
    expect(s.getItem(CURRENT)).toBeNull();
    expect(s.getItem(LEGACY)).toBe("legacy");
  });

  it("keeps both readable copies when deleting legacy data fails", () => {
    const s = installStorage([[LEGACY, "legacy"]]);
    vi.spyOn(s, "removeItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });

    expect(readMigratedStorage(CURRENT, LEGACY)).toBe("legacy");
    expect(s.getItem(CURRENT)).toBe("legacy");
    expect(s.getItem(LEGACY)).toBe("legacy");
  });
});
