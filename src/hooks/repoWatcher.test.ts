import { describe, expect, it } from "vitest";
import { mergeRefreshScope } from "./repoWatcher";

describe("mergeRefreshScope", () => {
  it("keeps ordinary file/index events on the worktree-only path", () => {
    expect(mergeRefreshScope(null, "worktree")).toBe("worktree");
    expect(mergeRefreshScope("worktree", "worktree")).toBe("worktree");
  });

  it("upgrades a watcher burst when any event can affect the graph", () => {
    expect(mergeRefreshScope("worktree", "graph")).toBe("all");
    expect(mergeRefreshScope("all", "worktree")).toBe("all");
  });
});
