import { describe, expect, it } from "vitest";
import {
  buildGraphActionSpecs,
  findOtherBranchWorktree,
  type BranchDragRef,
  type GraphDropTarget,
} from "./graphActions";

const local = (name: string): BranchDragRef => ({ name, kind: "local" });
const remote = (name: string): BranchDragRef => ({ name, kind: "remote" });
const branch = (name: string): GraphDropTarget => ({ kind: "local", name });
const remoteTarget = (name: string): GraphDropTarget => ({ kind: "remote", name });
const commit = (sha = "abcdef0123456789"): GraphDropTarget => ({
  kind: "commit",
  sha,
  shortSha: sha.slice(0, 7),
});

describe("buildGraphActionSpecs", () => {
  it("offers local-target integration and both directions of every move", () => {
    const specs = buildGraphActionSpecs(local("feature"), branch("main"), {
      targetToSource: true,
      sourceToTarget: true,
    });
    expect(specs.map((x) => x.kind)).toEqual([
      "fast-forward-target",
      "fast-forward-source",
      "merge-target",
      "rebase-source",
      "rebase-target",
      "reset-source",
      "reset-target",
    ]);
  });

  it("keeps the rebase directions straight: source variant moves the dragged branch", () => {
    const specs = buildGraphActionSpecs(local("feature"), branch("main"), {
      targetToSource: false,
      sourceToTarget: false,
    });
    const label = (kind: string) => specs.find((x) => x.kind === kind)?.label;
    expect(label("rebase-source")).toBe("Rebase feature onto main");
    expect(label("rebase-target")).toBe("Rebase main onto feature");
    expect(label("reset-source")).toBe("Reset feature to main");
    expect(label("reset-target")).toBe("Reset main to feature");
  });

  it("lets a remote ref feed a local target but never offers moving the remote", () => {
    const specs = buildGraphActionSpecs(remote("origin/main"), branch("main"), {
      targetToSource: true,
      sourceToTarget: true,
    });
    expect(specs.map((x) => x.kind)).toEqual([
      "fast-forward-target",
      "merge-target",
      "rebase-target",
      "reset-target",
    ]);
  });

  it("offers fast-forward, rebase, and confirmed reset for a local branch dropped on a commit", () => {
    const specs = buildGraphActionSpecs(local("feature"), commit(), {
      targetToSource: false,
      sourceToTarget: true,
    });
    expect(specs.map((x) => x.kind)).toEqual([
      "fast-forward-source",
      "rebase-source",
      "reset-source",
    ]);
  });

  it("offers fast-forward, rebase, and confirmed reset for a local branch dropped on a remote ref", () => {
    const specs = buildGraphActionSpecs(local("develop"), remoteTarget("origin/develop"), {
      targetToSource: false,
      sourceToTarget: true,
    });
    expect(specs.map((x) => x.kind)).toEqual([
      "fast-forward-source",
      "rebase-source",
      "reset-source",
    ]);
  });

  it("rejects a remote ref dropped on a commit", () => {
    expect(
      buildGraphActionSpecs(remote("origin/main"), commit(), {
        targetToSource: false,
        sourceToTarget: true,
      }),
    ).toEqual([]);
  });

  it("rejects a remote ref dropped on a remote ref", () => {
    expect(
      buildGraphActionSpecs(remote("origin/feature"), remoteTarget("origin/main"), {
        targetToSource: false,
        sourceToTarget: true,
      }),
    ).toEqual([]);
  });
});

describe("findOtherBranchWorktree", () => {
  const worktrees = [
    { path: "/repo", branch: "main" },
    { path: "/repo-feature", branch: "feature" },
  ];

  it("detects a branch owned by the main worktree from a linked worktree", () => {
    expect(findOtherBranchWorktree(worktrees, "main", "/repo-feature")?.path).toBe("/repo");
  });

  it("ignores the active worktree, including trailing-slash differences", () => {
    expect(findOtherBranchWorktree(worktrees, "feature", "/repo-feature/")).toBeNull();
  });
});
