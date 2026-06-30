import { describe, it, expect } from "vitest";
import type { RepoSummary, WorktreeInfo } from "@/lib/api";
import {
  activeWorktree,
  isActiveWorktreePath,
  linkedWorktrees,
  worktreeIndicatorView,
  worktreeLabel,
} from "./worktrees";

const summary = (over: Partial<RepoSummary> = {}): RepoSummary => ({
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: "c1",
  detached: false,
  ...over,
});

const wt = (over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  name: "repo",
  path: "/repo",
  branch: "main",
  isMain: true,
  ...over,
});

const main = wt();
const linked = wt({ name: "repo-wt-feature", path: "/repo-wt-feature", branch: "feature/x", isMain: false });
const detachedLinked = wt({ name: "repo-wt-detached", path: "/repo-wt-detached", branch: null, isMain: false });

describe("isActiveWorktreePath", () => {
  it("matches on workdir and on the canonical repo path", () => {
    expect(isActiveWorktreePath(summary({ workdir: "/repo", path: "/other" }), "/repo")).toBe(true);
    expect(isActiveWorktreePath(summary({ workdir: "/wd", path: "/repo" }), "/repo")).toBe(true);
  });
  it("ignores trailing slashes on either side", () => {
    expect(isActiveWorktreePath(summary({ workdir: "/repo/" }), "/repo")).toBe(true);
    expect(isActiveWorktreePath(summary({ workdir: "/repo" }), "/repo/")).toBe(true);
  });
  it("returns false for a different path and for a null summary", () => {
    expect(isActiveWorktreePath(summary(), "/elsewhere")).toBe(false);
    expect(isActiveWorktreePath(null, "/repo")).toBe(false);
  });
});

describe("activeWorktree", () => {
  it("finds the worktree backing the open repo", () => {
    // Opening a linked worktree points both workdir and path at it.
    expect(activeWorktree([main, linked], summary({ workdir: "/repo-wt-feature", path: "/repo-wt-feature" }))).toBe(linked);
  });
  it("returns null when nothing matches", () => {
    expect(activeWorktree([main, linked], summary({ workdir: "/nope", path: "/nope" }))).toBeNull();
    expect(activeWorktree([main], null)).toBeNull();
  });
});

describe("linkedWorktrees", () => {
  it("excludes the primary worktree", () => {
    expect(linkedWorktrees([main, linked, detachedLinked])).toEqual([linked, detachedLinked]);
  });
});

describe("worktreeLabel", () => {
  it("prefers the branch, falling back to the directory name when detached", () => {
    expect(worktreeLabel(linked)).toBe("feature/x");
    expect(worktreeLabel(detachedLinked)).toBe("repo-wt-detached");
  });
});

describe("worktreeIndicatorView", () => {
  it("is 'none' when there are no linked worktrees", () => {
    expect(worktreeIndicatorView([main], summary())).toEqual({ kind: "none" });
    expect(worktreeIndicatorView([], summary())).toEqual({ kind: "none" });
  });

  it("is 'count' when the main worktree is open but linked ones exist", () => {
    expect(worktreeIndicatorView([main, linked, detachedLinked], summary({ workdir: "/repo" }))).toEqual({
      kind: "count",
      linkedCount: 2,
    });
  });

  it("is 'active' (naming the worktree + path) when the open repo is a linked worktree", () => {
    expect(worktreeIndicatorView([main, linked], summary({ workdir: "/repo-wt-feature", path: "/repo-wt-feature" }))).toEqual({
      kind: "active",
      name: "repo-wt-feature",
      path: "/repo-wt-feature",
      linkedCount: 1,
    });
  });
});
