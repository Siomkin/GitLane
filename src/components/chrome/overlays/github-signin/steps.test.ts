import { describe, expect, it } from "vitest";

import { SIGNIN_STEP_COUNT, signinStepIndex, signinStepLabel } from "./steps";

describe("github sign-in steps", () => {
  it("maps backend step ids onto the display rows", () => {
    // Row 0 has no event (active from the start); each step advances one row.
    expect(signinStepIndex("code")).toBe(1);
    expect(signinStepIndex("browser")).toBe(2);
    expect(signinStepIndex("authorized")).toBe(3);
  });

  it("returns -1 for an unknown step id", () => {
    expect(signinStepIndex("nope")).toBe(-1);
  });

  it("phrases labels for their state and names the flow's host (GHES-aware)", () => {
    expect(SIGNIN_STEP_COUNT).toBe(4);
    // Row 1 must not run ahead of reality: present-progressive while active,
    // completed once done — and never hardcode github.com.
    expect(signinStepLabel(1, "github.acme.com", false)).toBe(
      "Opening github.acme.com in your browser",
    );
    expect(signinStepLabel(1, "github.acme.com", true)).toBe("Opened github.acme.com");
    expect(signinStepLabel(2, "github.com", false)).toBe("Waiting for authorization…");
    expect(signinStepLabel(2, "github.com", true)).toBe("Authorized");
  });
});
