import { describe, it, expect } from "vitest";
import type { RepoSummary, WorktreeInfo } from "@/lib/api";
import {
  activeWorktree,
  isActiveWorktreePath,
  worktreeIndicatorView,
  worktreeLabel,
  worktreeName,
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

// Two codex-style worktrees: every one is nested under <id>/<repo>, so the leaf
// directory is the repo name ("GitLane") for all of them.
const codexMain = wt({ name: "GitLane", path: "/Volumes/Dev/GitLane", branch: "main", isMain: true });
const codexA = wt({ name: "GitLane", path: "/Users/me/.codex/worktrees/1e75/GitLane", branch: null, isMain: false });
const codexB = wt({ name: "GitLane", path: "/Users/me/.codex/worktrees/2f88/GitLane", branch: null, isMain: false });

describe("worktreeName", () => {
  it("uses the plain leaf when it's unique", () => {
    expect(worktreeName(linked, [main, linked, detachedLinked])).toBe("repo-wt-feature");
  });
  it("falls back to <parent>/<leaf> when the leaf collides with another worktree", () => {
    expect(worktreeName(codexA, [codexMain, codexA, codexB])).toBe("1e75/GitLane");
    expect(worktreeName(codexB, [codexMain, codexA, codexB])).toBe("2f88/GitLane");
  });
  it("keeps the main worktree's plain leaf even when a linked one collides", () => {
    expect(worktreeName(codexMain, [codexMain, codexA])).toBe("GitLane");
  });
});

describe("worktreeLabel", () => {
  it("prefers the branch, falling back to the directory name when detached", () => {
    expect(worktreeLabel(linked, [main, linked])).toBe("feature/x");
    expect(worktreeLabel(detachedLinked, [main, detachedLinked])).toBe("repo-wt-detached");
  });
  it("uses the disambiguated name for a detached codex worktree", () => {
    expect(worktreeLabel(codexA, [codexMain, codexA, codexB])).toBe("1e75/GitLane");
  });
});

describe("worktreeIndicatorView", () => {
  it("is 'none' when there are no linked worktrees", () => {
    expect(worktreeIndicatorView([main], summary())).toEqual({ kind: "none" });
    expect(worktreeIndicatorView([], summary())).toEqual({ kind: "none" });
  });

  it("is 'none' when the main worktree is open, even though linked ones exist", () => {
    // No permanent count badge — linked worktrees live in the navigator.
    expect(worktreeIndicatorView([main, linked, detachedLinked], summary({ workdir: "/repo" }))).toEqual({
      kind: "none",
    });
  });

  it("is 'active' (naming the worktree + path) when the open repo is a linked worktree", () => {
    expect(worktreeIndicatorView([main, linked], summary({ workdir: "/repo-wt-feature", path: "/repo-wt-feature" }))).toEqual({
      kind: "active",
      name: "repo-wt-feature",
      path: "/repo-wt-feature",
    });
  });

  it("disambiguates the active name for a codex worktree whose leaf is the repo name", () => {
    const s = summary({ workdir: "/Users/me/.codex/worktrees/1e75/GitLane", path: "/Users/me/.codex/worktrees/1e75/GitLane" });
    expect(worktreeIndicatorView([codexMain, codexA, codexB], s)).toEqual({
      kind: "active",
      name: "1e75/GitLane",
      path: "/Users/me/.codex/worktrees/1e75/GitLane",
    });
  });
});
