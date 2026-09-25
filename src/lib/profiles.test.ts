import { describe, expect, it } from "vitest";
import { isValidEmail, profileInitials } from "./profiles";

describe("profileInitials", () => {
  it("uses the first letters of the first two words", () => {
    expect(profileInitials("Work Account")).toBe("WA");
  });
  it("falls back to the first two characters of a single word", () => {
    expect(profileInitials("personal")).toBe("PE");
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
