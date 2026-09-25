import { describe, it, expect } from "vitest";
import { handoffStepIndex, handoffStepLabels } from "./steps";

describe("handoffStepLabels", () => {
  it("names the branch and destination in the checkout/open rows", () => {
    const labels = handoffStepLabels("feature", "main");
    expect(labels).toHaveLength(5);
    expect(labels[1]).toBe("Detaching feature from the source worktree");
    expect(labels[2]).toBe("Checking out feature in main");
    expect(labels[4]).toBe("Opening main");
  });
});

describe("handoffStepIndex", () => {
  it("maps both stash phases to the first row and both applies to the fourth", () => {
    expect(handoffStepIndex("stashSource")).toBe(0);
    expect(handoffStepIndex("stashDestination")).toBe(0);
    expect(handoffStepIndex("detach")).toBe(1);
    expect(handoffStepIndex("checkout")).toBe(2);
    expect(handoffStepIndex("applySource")).toBe(3);
    expect(handoffStepIndex("applyDestination")).toBe(3);
    expect(handoffStepIndex("finalize")).toBe(4);
  });

  it("returns -1 for an unknown step id (newer backend)", () => {
    expect(handoffStepIndex("somethingNew")).toBe(-1);
  });
});
