import { describe, it, expect, vi } from "vitest";
import type { WorktreeInfo } from "@/lib/api";
import type { ConfirmRequest, PromptRequest } from "@/store/ui";
import { handoffDestinationOptions, promptWorktreeHandoff } from "./worktreeHandoff";

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
});

describe("promptWorktreeHandoff", () => {
  const setup = (sourceChanges: number | null) => {
    let prompt: PromptRequest | null = null;
    let confirm: ConfirmRequest | null = null;
    const run = vi.fn();
    const move = vi.fn().mockResolvedValue("ok");
    promptWorktreeHandoff({
      branch: "feature",
      sourcePath: feature.path,
      worktrees: [main, feature],
      sourceChanges,
      requestPrompt: (r) => (prompt = r),
      requestConfirm: (r) => (confirm = r),
      run,
      moveBranchToWorktree: move,
    });
    return { get: () => ({ prompt, confirm }), run, move };
  };

  it("opens the picker, then a detach confirm, then runs the carrying move", () => {
    const { get, run, move } = setup(3);
    const { prompt } = get();
    expect(prompt!.title).toBe("Hand off feature to…");
    expect(prompt!.options?.map((o) => o.value)).toEqual(["/work/repo"]);

    // Picking a destination raises the confirm (not the move yet).
    prompt!.onSubmit("/work/repo");
    expect(move).not.toHaveBeenCalled();
    const { confirm } = get();
    expect(confirm!.title).toBe("Hand off feature to main?");
    // The confirm names the detach and the carried count.
    expect(confirm!.warnings?.join(" ")).toMatch(/detached HEAD/);
    expect(confirm!.details?.join(" ")).toMatch(/3 uncommitted changes/);

    // Confirming runs the move (always carrying: the backend no-ops when clean).
    confirm!.onConfirm();
    expect(run).toHaveBeenCalledTimes(1);
    run.mock.calls[0][0]();
    expect(move).toHaveBeenCalledWith("feature", "/work/repo-feature", "/work/repo", true);
  });

  it("phrases the carry line conditionally when the source dirtiness is unknown", () => {
    const { get } = setup(null);
    get().prompt!.onSubmit("/work/repo");
    expect(get().confirm!.details?.join(" ")).toMatch(/Any uncommitted changes/);
  });

  it("reports when there is no destination instead of opening a picker", () => {
    const onNoDestinations = vi.fn();
    const requestPrompt = vi.fn();
    promptWorktreeHandoff({
      branch: "feature",
      sourcePath: feature.path,
      worktrees: [feature],
      sourceChanges: 0,
      requestPrompt,
      requestConfirm: vi.fn(),
      run: vi.fn(),
      moveBranchToWorktree: vi.fn(),
      onNoDestinations,
    });
    expect(onNoDestinations).toHaveBeenCalledTimes(1);
    expect(requestPrompt).not.toHaveBeenCalled();
  });
});
