import { describe, it, expect } from "vitest";
import type { WorktreeInfo } from "@/lib/api";
import { removeDetachedStepLabels, removeDetachedStepStatus, removeDetachedSummary } from "./steps";

const wt = (over: Partial<WorktreeInfo>): WorktreeInfo => ({
  name: "wt",
  path: "/work/wt",
  branch: null,
  isMain: false,
  ...over,
});

describe("removeDetachedStepLabels", () => {
  it("labels each row with the distinguishing directory name", () => {
    const a = wt({ name: "a", path: "/work/a" });
    const b = wt({ name: "b", path: "/work/b" });
    expect(removeDetachedStepLabels([a, b])).toEqual(["a", "b"]);
  });

  it("disambiguates codex-style siblings that share a leaf", () => {
    const x = wt({ name: "GitLane", path: "/c/worktrees/1e75/GitLane" });
    const y = wt({ name: "GitLane", path: "/c/worktrees/2f88/GitLane" });
    expect(removeDetachedStepLabels([x, y])).toEqual(["1e75/GitLane", "2f88/GitLane"]);
  });
});

describe("removeDetachedStepStatus", () => {
  it("marks recorded rows done/failed, the next row active while running, the rest pending", () => {
    const outcomes = ["ok", "fail"] as const;
    expect(removeDetachedStepStatus(0, outcomes, true)).toBe("done");
    expect(removeDetachedStepStatus(1, outcomes, true)).toBe("failed");
    expect(removeDetachedStepStatus(2, outcomes, true)).toBe("active");
    expect(removeDetachedStepStatus(3, outcomes, true)).toBe("pending");
  });

  it("never marks a row active once the sweep has finished", () => {
    expect(removeDetachedStepStatus(2, ["ok", "ok"], false)).toBe("pending");
  });
});

describe("removeDetachedSummary", () => {
  it("reports a clean sweep with a pluralized noun", () => {
    expect(removeDetachedSummary(["ok", "ok"], 2, null)).toBe("Removed 2 detached worktrees");
    expect(removeDetachedSummary(["ok"], 1, null)).toBe("Removed 1 detached worktree");
  });

  it("reports the removed/total split and the first error when some failed", () => {
    expect(removeDetachedSummary(["fail", "ok"], 2, "dirty worktree")).toBe(
      "Removed 1 of 2 detached worktrees — dirty worktree",
    );
  });
});
