import { describe, it, expect } from "vitest";
import {
  DELETE_WORKTREE_REFRESH_ROW,
  DELETE_WORKTREE_STEP_COUNT,
  deleteWorktreeStepIndex,
  deleteWorktreeStepLabels,
  deleteWorktreeStepStatus,
} from "./steps";

describe("deleteWorktreeStepLabels", () => {
  it("is the three fixed rows in execution order", () => {
    expect(deleteWorktreeStepLabels()).toEqual([
      "Removing worktree",
      "Deleting branch",
      "Refreshing",
    ]);
    expect(DELETE_WORKTREE_STEP_COUNT).toBe(3);
    // The terminal row has no backend event; the run hook advances to it itself.
    expect(DELETE_WORKTREE_REFRESH_ROW).toBe(2);
  });
});

describe("deleteWorktreeStepIndex", () => {
  it("maps the two backend step ids to the first two rows", () => {
    expect(deleteWorktreeStepIndex("removeWorktree")).toBe(0);
    expect(deleteWorktreeStepIndex("deleteBranch")).toBe(1);
  });

  it("returns -1 for an unknown step id (newer backend) and for the eventless refresh row", () => {
    expect(deleteWorktreeStepIndex("somethingNew")).toBe(-1);
    // "Refreshing" has no backend event, so no id resolves to row 2.
    expect(deleteWorktreeStepIndex("refresh")).toBe(-1);
  });
});

describe("deleteWorktreeStepStatus", () => {
  it("marks rows before the reached one done — folding in any skipped step", () => {
    const statuses = [0, 1, 2].map((i) => deleteWorktreeStepStatus(i, 1, false));
    expect(statuses).toEqual(["done", "active", "pending"]);
  });

  it("lights the Refreshing row active once the run hook advances to it", () => {
    const statuses = [0, 1, 2].map((i) => deleteWorktreeStepStatus(i, DELETE_WORKTREE_REFRESH_ROW, false));
    expect(statuses).toEqual(["done", "done", "active"]);
  });

  it("completes every row once the delete has finished", () => {
    const statuses = [0, 1, 2].map((i) => deleteWorktreeStepStatus(i, 1, true));
    expect(statuses).toEqual(["done", "done", "done"]);
  });
});
