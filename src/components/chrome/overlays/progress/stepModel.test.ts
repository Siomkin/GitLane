import { describe, expect, it } from "vitest";

import { stepIndexIn, stepStatus } from "./stepModel";

describe("stepStatus", () => {
  it("derives pending / active / done from the furthest row reached", () => {
    // Before any milestone (reached -1) every row is pending — row 0 must not
    // spin before its step has started.
    expect([0, 1, 2].map((i) => stepStatus(i, -1, false))).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    // Rows before the reached one are done, which folds in any step the
    // backend skipped (a clean hand-off never emits its stash step).
    expect([0, 1, 2, 3, 4].map((i) => stepStatus(i, 2, false))).toEqual([
      "done",
      "done",
      "active",
      "pending",
      "pending",
    ]);
  });

  it("completes every row once the run has finished, regardless of reached", () => {
    expect([0, 1, 2].map((i) => stepStatus(i, 0, true))).toEqual(["done", "done", "done"]);
  });
});

describe("stepIndexIn", () => {
  it("maps a step id to its row, and an unknown id to -1", () => {
    const events = [["prepare"], ["stash", "detach"], ["checkout"]];
    expect(stepIndexIn(events, "detach")).toBe(1);
    expect(stepIndexIn(events, "somethingNew")).toBe(-1);
  });
});
