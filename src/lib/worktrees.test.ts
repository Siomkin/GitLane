import { describe, it, expect } from "vitest";
import type { RepoSummary, WorktreeInfo } from "@/lib/api";
import {
  activeWorktree,
  isActiveWorktreePath,
  isAgentManagedWorktree,
  isDetachedWorktree,
  removableDetachedWorktrees,
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

describe("isDetachedWorktree", () => {
  it("is true only for a branch-less entry with a real working tree", () => {
    expect(isDetachedWorktree(detachedLinked)).toBe(true);
    expect(isDetachedWorktree(linked)).toBe(false);
  });
  it("excludes bare and prunable entries (neither has a usable checkout)", () => {
    expect(isDetachedWorktree(wt({ branch: null, bare: true }))).toBe(false);
    expect(isDetachedWorktree(wt({ branch: null, prunable: true }))).toBe(false);
  });
});

// GL-297: agents detach their worktrees by construction (git allows a branch in
// only one worktree), so "detached" marks the most active checkouts, not the
// disposable ones. Detection is by path convention — the only signal git gives.
describe("isAgentManagedWorktree", () => {
  it("recognises the known agent worktree roots", () => {
    expect(isAgentManagedWorktree(wt({ path: "/Users/me/.codex/worktrees/6d30/GitLane" }))).toBe(true);
    expect(isAgentManagedWorktree(wt({ path: "/Users/me/.claude/worktrees/abc/repo" }))).toBe(true);
    // Trailing slashes are normalised before matching.
    expect(isAgentManagedWorktree(wt({ path: "/Users/me/.codex/worktrees/6d30/GitLane/" }))).toBe(true);
  });

  it("stays narrow — a false positive would hide a genuinely disposable worktree", () => {
    expect(isAgentManagedWorktree(wt({ path: "/work/feature" }))).toBe(false);
    // Similar-looking but not the convention: no `worktrees` segment under the
    // tool directory.
    expect(isAgentManagedWorktree(wt({ path: "/Users/me/.codex/GitLane" }))).toBe(false);
    expect(isAgentManagedWorktree(wt({ path: "/work/codex/worktrees/x" }))).toBe(false);
  });
});

describe("removableDetachedWorktrees", () => {
  it("keeps detached linked worktrees and drops branched ones", () => {
    expect(removableDetachedWorktrees([main, linked, detachedLinked], summary())).toEqual([detachedLinked]);
  });
  it("never offers the main worktree, even when its HEAD is detached", () => {
    const detachedMain = wt({ branch: null });
    expect(removableDetachedWorktrees([detachedMain, linked], summary())).toEqual([]);
  });
  it("never offers the worktree backing the open tab", () => {
    const s = summary({ workdir: "/repo-wt-detached", path: "/repo-wt-detached" });
    expect(removableDetachedWorktrees([main, detachedLinked], s)).toEqual([]);
  });
  it("never offers a locked worktree (a bulk force would override git's dirty check)", () => {
    const lockedDetached = wt({ name: "locked", path: "/locked", branch: null, isMain: false, locked: true });
    expect(removableDetachedWorktrees([main, lockedDetached, detachedLinked], summary())).toEqual([
      detachedLinked,
    ]);
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
