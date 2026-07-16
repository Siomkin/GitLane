import { describe, expect, it } from "vitest";
import { IDENTITY_COLORS, identityColor } from "./identityColor";

describe("identityColor", () => {
  it("is stable and normalizes case/whitespace", () => {
    const color = identityColor("jane@example.com");
    expect(identityColor(" Jane@Example.COM ")).toBe(color);
    expect(IDENTITY_COLORS).toContain(color);
  });

  it("spreads distinct identities across the palette", () => {
    const colors = new Set(
      ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com"].map((email) =>
        identityColor(email),
      ),
    );
    expect(colors.size).toBeGreaterThan(1);
  });

  it("lets a saved override win over the hash, matched case-insensitively", () => {
    const overrides = { "jane@example.com": "#123456" };
    expect(identityColor("Jane@Example.com", overrides)).toBe("#123456");
    // An email with no override still hashes normally.
    expect(identityColor("bob@example.com", overrides)).not.toBe("#123456");
  });
});
