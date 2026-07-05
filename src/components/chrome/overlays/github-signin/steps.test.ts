import { describe, expect, it } from "vitest";

import { SIGNIN_STEP_COUNT, signinStepIndex, signinStepLabel, signinStepStatus } from "./steps";

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

  it("derives pending / active / done from the furthest row reached", () => {
    // Before any milestone (reached -1): every row is pending — row 0 must not
    // spin as "Code copied" before the code has arrived.
    expect(signinStepStatus(0, -1, false)).toBe("pending");
    expect(signinStepStatus(1, -1, false)).toBe("pending");
    // Once the code arrives (reached 1): row 0 done, row 1 active.
    expect(signinStepStatus(0, 1, false)).toBe("done");
    expect(signinStepStatus(1, 1, false)).toBe("active");
    // After the browser opened (reached row 2): rows 0-1 done, row 2 active.
    expect(signinStepStatus(0, 2, false)).toBe("done");
    expect(signinStepStatus(1, 2, false)).toBe("done");
    expect(signinStepStatus(2, 2, false)).toBe("active");
    expect(signinStepStatus(3, 2, false)).toBe("pending");
    // Resolved: everything done regardless of reached.
    expect(signinStepStatus(3, 2, true)).toBe("done");
  });
});
