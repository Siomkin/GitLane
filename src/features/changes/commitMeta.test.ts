import { describe, it, expect } from "vitest";
import { initials } from "./commitMeta";

describe("initials", () => {
  it("takes the first letter of the first two words, uppercased", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
  });

  it("handles a single-word name", () => {
    expect(initials("Linus")).toBe("L");
  });

  it("uses only the first two words for longer names", () => {
    expect(initials("John Ronald Reuel Tolkien")).toBe("JR");
  });

  it("collapses leading/trailing/inner whitespace", () => {
    expect(initials("  Grace   Hopper  ")).toBe("GH");
  });

  it("returns an empty string for an empty or blank name", () => {
    expect(initials("")).toBe("");
    expect(initials("   ")).toBe("");
  });
});
