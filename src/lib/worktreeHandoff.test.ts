import { describe, it, expect, vi } from "vitest";
import type { WorktreeInfo } from "@/lib/api";
import type { HandoffRequest } from "@/store/ui";
import { carriedLine, handoffDestinationOptions, startWorktreeHandoff } from "./worktreeHandoff";

const wt = (over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  name: "repo",
  path: "/work/repo",
  branch: "main",
  isMain: true,
  ...over,
});

const main = wt();
const feature = wt({ name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false });
const scratch = wt({ name: "repo-scratch", path: "/work/repo-scratch", branch: null, isMain: false });

describe("handoffDestinationOptions", () => {
  it("lists every worktree except the source, with paths and a main marker", () => {
    const opts = handoffDestinationOptions([main, feature, scratch], feature.path);
    expect(opts.map((o) => o.value)).toEqual(["/work/repo", "/work/repo-scratch"]);
    // The main checkout is flagged in the hint; the full path is always shown.
    expect(opts[0]).toMatchObject({ label: "main", hint: "main · /work/repo" });
    // A detached worktree falls back to its directory name; path in the hint.
    expect(opts[1]).toMatchObject({ label: "repo-scratch", hint: "/work/repo-scratch" });
  });

  it("matches the source on its resolved path (trailing slash tolerant)", () => {
    const opts = handoffDestinationOptions([main, feature], `${feature.path}/`);
    expect(opts.map((o) => o.value)).toEqual(["/work/repo"]);
  });

  it("returns nothing when the source is the only worktree", () => {
    expect(handoffDestinationOptions([feature], feature.path)).toEqual([]);
  });

  it("excludes bare and prunable worktrees (no working tree to check out into)", () => {
    const bare = wt({ path: "/work/bare.git", branch: null, isMain: true, bare: true });
    const missing = wt({ path: "/work/gone", branch: null, isMain: false, prunable: true });
    const opts = handoffDestinationOptions([bare, main, feature, missing], feature.path);
    // Only the valid main checkout survives — bare + prunable are filtered out.
    expect(opts.map((o) => o.value)).toEqual(["/work/repo"]);
  });
});

describe("startWorktreeHandoff", () => {
  it("raises the hand-off dialog with the branch, source, and change count", () => {
    let req: HandoffRequest | null = null;
    startWorktreeHandoff({
      branch: "feature",
      sourcePath: feature.path,
      worktrees: [main, feature],
      sourceChanges: 3,
      openHandoff: (r) => (req = r),
    });
    expect(req).toEqual({ branch: "feature", sourcePath: "/work/repo-feature", sourceChanges: 3 });
  });

  it("reports when there is no destination instead of opening the dialog", () => {
    const onNoDestinations = vi.fn();
    const openHandoff = vi.fn();
    startWorktreeHandoff({
      branch: "feature",
      sourcePath: feature.path,
      worktrees: [feature],
      sourceChanges: 0,
      openHandoff,
      onNoDestinations,
    });
    expect(onNoDestinations).toHaveBeenCalledTimes(1);
    expect(openHandoff).not.toHaveBeenCalled();
  });
});

describe("carriedLine", () => {
  it("counts known changes, notes a clean source, and phrases unknown conditionally", () => {
    expect(carriedLine(3)).toMatch(/3 uncommitted changes .* carried/);
    expect(carriedLine(1)).toMatch(/1 uncommitted change /);
    expect(carriedLine(0)).toMatch(/no uncommitted changes/);
    expect(carriedLine(null)).toMatch(/Any uncommitted changes/);
  });
});
