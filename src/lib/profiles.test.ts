import { describe, expect, it } from "vitest";
import { isValidEmail, profileInitials } from "./profiles";

describe("profileInitials", () => {
  it("uses the first letters of the first two words", () => {
    expect(profileInitials("Work Account")).toBe("WA");
  });
  it("reads a single word as one letter — the same rule as every other avatar", () => {
    expect(profileInitials("personal")).toBe("P");
    expect(profileInitials("  ")).toBe("··");
  });
});

describe("isValidEmail", () => {
  it("accepts a dotted-domain address and trims surrounding space", () => {
    expect(isValidEmail("ada@example.com")).toBe(true);
    expect(isValidEmail("  ada@example.com  ")).toBe(true);
  });
  it("rejects malformed addresses", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("ada@localhost")).toBe(false);
    expect(isValidEmail("ada example.com")).toBe(false);
    expect(isValidEmail("@example.com")).toBe(false);
  });
});
