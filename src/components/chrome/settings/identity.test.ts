import { describe, it, expect } from "vitest";
import { isIdentityDirty, isIdentityValid, isValidEmail } from "./identity";

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

describe("isIdentityValid", () => {
  it("requires both a name and a well-formed email", () => {
    expect(isIdentityValid("Ada", "ada@example.com")).toBe(true);
    expect(isIdentityValid("  ", "ada@example.com")).toBe(false);
    expect(isIdentityValid("Ada", "nope")).toBe(false);
  });
});

describe("isIdentityDirty", () => {
  it("is clean when fields match the pinned identity", () => {
    expect(isIdentityDirty("Ada", "ada@example.com", { name: "Ada", email: "ada@example.com" })).toBe(
      false,
    );
  });
  it("is dirty against a null identity once a field is non-empty", () => {
    expect(isIdentityDirty("", "", null)).toBe(false);
    expect(isIdentityDirty("Ada", "", null)).toBe(true);
  });
  it("is dirty when either field diverges", () => {
    const id = { name: "Ada", email: "ada@example.com" };
    expect(isIdentityDirty("Grace", "ada@example.com", id)).toBe(true);
    expect(isIdentityDirty("Ada", "grace@example.com", id)).toBe(true);
  });
});
