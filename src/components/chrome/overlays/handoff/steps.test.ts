import { describe, it, expect } from "vitest";
import { handoffStepIndex, handoffStepLabels, handoffStepStatus } from "./steps";

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

describe("handoffStepStatus", () => {
  it("marks rows before the reached one done — folding in skipped steps", () => {
    // A clean source/destination never emits the stash step; reaching `checkout`
    // (row 2) must still complete rows 0 and 1.
    const statuses = [0, 1, 2, 3, 4].map((i) => handoffStepStatus(i, 2, false));
    expect(statuses).toEqual(["done", "done", "active", "pending", "pending"]);
  });

  it("completes every row once the move has finished", () => {
    const statuses = [0, 1, 2, 3, 4].map((i) => handoffStepStatus(i, 2, true));
    expect(statuses).toEqual(["done", "done", "done", "done", "done"]);
  });
});
