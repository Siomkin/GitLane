import { describe, expect, it } from "vitest";
import { profileInitials } from "./profiles";

describe("profileInitials", () => {
  it("uses the first letters of the first two words", () => {
    expect(profileInitials("Work Account")).toBe("WA");
  });
  it("falls back to the first two characters of a single word", () => {
    expect(profileInitials("personal")).toBe("PE");
  });
});
