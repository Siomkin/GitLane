import { beforeEach, describe, expect, it, vi } from "vitest";
import { readMigratedStorage } from "./storage";

const CURRENT = "gitlane.test:v1";
const LEGACY = "gitlane.test";

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("readMigratedStorage", () => {
  it("copies a legacy value before deleting its old key", () => {
    localStorage.setItem(LEGACY, "legacy");

    expect(readMigratedStorage(CURRENT, LEGACY)).toBe("legacy");
    expect(localStorage.getItem(CURRENT)).toBe("legacy");
    expect(localStorage.getItem(LEGACY)).toBeNull();
  });

  it("prefers the versioned value and removes stale legacy data", () => {
    localStorage.setItem(CURRENT, "current");
    localStorage.setItem(LEGACY, "stale");

    expect(readMigratedStorage(CURRENT, LEGACY)).toBe("current");
    expect(localStorage.getItem(LEGACY)).toBeNull();
  });

  it("returns readable legacy data when copying it fails", () => {
    localStorage.setItem(LEGACY, "legacy");
    vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    expect(readMigratedStorage(CURRENT, LEGACY)).toBe("legacy");
    expect(localStorage.getItem(CURRENT)).toBeNull();
    expect(localStorage.getItem(LEGACY)).toBe("legacy");
  });

  it("keeps both readable copies when deleting legacy data fails", () => {
    localStorage.setItem(LEGACY, "legacy");
    vi.spyOn(localStorage, "removeItem").mockImplementationOnce(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });

    expect(readMigratedStorage(CURRENT, LEGACY)).toBe("legacy");
    expect(localStorage.getItem(CURRENT)).toBe("legacy");
    expect(localStorage.getItem(LEGACY)).toBe("legacy");
  });
});
