import { describe, expect, it } from "vitest";
import { mergeRefreshScope, normalizeWatchPath } from "./repoWatcher";

describe("normalizeWatchPath", () => {
  it("leaves an ordinary path untouched", () => {
    expect(normalizeWatchPath("/Users/me/repo")).toBe("/Users/me/repo");
  });

  it("trims a trailing separator so it routes like the un-slashed form", () => {
    expect(normalizeWatchPath("/Users/me/repo/")).toBe("/Users/me/repo");
    expect(normalizeWatchPath("C:\\repo\\")).toBe("C:\\repo");
  });

  it("preserves a lone filesystem-root separator", () => {
    expect(normalizeWatchPath("/")).toBe("/");
  });
});

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
