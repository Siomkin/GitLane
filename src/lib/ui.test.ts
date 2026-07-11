import { describe, expect, it } from "vitest";
import { initials } from "./ui";

describe("initials", () => {
  it("takes the first letter of the first two words, uppercased", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("ada lovelace")).toBe("AL");
    expect(initials("Ada Byron Lovelace")).toBe("AB");
  });

  it("yields a single letter for one-word names", () => {
    expect(initials("ada")).toBe("A");
  });

  it("returns empty for blank names", () => {
    expect(initials("")).toBe("");
    expect(initials("   ")).toBe("");
  });

  it("collapses repeated and mixed whitespace between words", () => {
    expect(initials("  ada   \t lovelace  ")).toBe("AL");
    expect(initials("  ada  ")).toBe("A");
  });

  it("uppercases non-ASCII letters (BMP)", () => {
    expect(initials("éva łukasz")).toBe("ÉŁ");
    expect(initials("юрий гагарин")).toBe("ЮГ");
  });
});
