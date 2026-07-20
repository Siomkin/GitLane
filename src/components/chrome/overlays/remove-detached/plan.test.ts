// GL-297: the sweep's safe-to-delete decision. Pure — the dialog's own tests
// cover the probe wiring and rendering.
import { describe, it, expect } from "vitest";
import type { WorktreeInfo } from "@/lib/api";
import { buildRemoveDetachedPlan, describeSkip, type DirtyProbeResults } from "./plan";

const wt = (path: string): WorktreeInfo => ({
  name: path.split("/").pop() ?? path,
  path,
  branch: null,
  isMain: false,
});

const clean = { modified: 0, untracked: 0 };
const probes = (entries: Record<string, { modified: number; untracked: number } | null>): DirtyProbeResults =>
  new Map(Object.entries(entries));

describe("buildRemoveDetachedPlan", () => {
  it("removes a candidate probed clean", () => {
    const plan = buildRemoveDetachedPlan([wt("/work/a")], probes({ "/work/a": clean }));
    expect(plan.remove.map((w) => w.path)).toEqual(["/work/a"]);
    expect(plan.skip).toHaveLength(0);
  });

  it("withholds uncommitted work rather than letting git refuse mid-sweep", () => {
    const plan = buildRemoveDetachedPlan(
      [wt("/work/a"), wt("/work/b")],
      probes({ "/work/a": clean, "/work/b": { modified: 2, untracked: 1 } }),
    );
    expect(plan.remove.map((w) => w.path)).toEqual(["/work/a"]);
    expect(plan.skip).toHaveLength(1);
    expect(plan.skip[0]!.reason).toBe("uncommittedWork");
  });

  // Agents detach by construction, so a clean agent worktree is still live.
  it("withholds an agent-managed worktree even when clean", () => {
    const agent = wt("/Users/me/.codex/worktrees/6d30/GitLane");
    const plan = buildRemoveDetachedPlan([agent], probes({ [agent.path]: clean }));
    expect(plan.remove).toHaveLength(0);
    expect(plan.skip[0]!.reason).toBe("agentManaged");
  });

  it("prefers the agent reason over dirtiness, as the more informative one", () => {
    const agent = wt("/Users/me/.claude/worktrees/x/repo");
    const plan = buildRemoveDetachedPlan([agent], probes({ [agent.path]: { modified: 5, untracked: 0 } }));
    expect(plan.skip[0]!.reason).toBe("agentManaged");
  });

  // Not knowing is a reason to leave a worktree alone in a *bulk* destructive
  // action; the per-row removal remains available and states the uncertainty.
  it("withholds a candidate whose probe failed or never answered", () => {
    const failed = buildRemoveDetachedPlan([wt("/work/a")], probes({ "/work/a": null }));
    expect(failed.remove).toHaveLength(0);
    expect(failed.skip[0]!.reason).toBe("unverified");

    const missing = buildRemoveDetachedPlan([wt("/work/a")], new Map());
    expect(missing.remove).toHaveLength(0);
    expect(missing.skip[0]!.reason).toBe("unverified");
  });

  it("keeps candidate order and never both removes and skips one", () => {
    const candidates = [wt("/work/a"), wt("/work/b"), wt("/work/c")];
    const plan = buildRemoveDetachedPlan(
      candidates,
      probes({ "/work/a": clean, "/work/b": { modified: 1, untracked: 0 }, "/work/c": clean }),
    );
    expect(plan.remove.map((w) => w.path)).toEqual(["/work/a", "/work/c"]);
    expect(plan.remove.length + plan.skip.length).toBe(candidates.length);
  });
});

describe("describeSkip", () => {
  it("names the concrete uncommitted work, singularising and dropping a zero half", () => {
    const at = (dirty: { modified: number; untracked: number }) =>
      describeSkip({ worktree: wt("/w"), reason: "uncommittedWork", dirty });
    expect(at({ modified: 29, untracked: 3 })).toBe("Has 29 modified files and 3 untracked files");
    expect(at({ modified: 1, untracked: 0 })).toBe("Has 1 modified file");
    expect(at({ modified: 0, untracked: 2 })).toBe("Has 2 untracked files");
  });

  it("explains the non-dirty reasons", () => {
    expect(describeSkip({ worktree: wt("/w"), reason: "agentManaged", dirty: null })).toBe(
      "In use by a coding agent",
    );
    expect(describeSkip({ worktree: wt("/w"), reason: "unverified", dirty: null })).toBe(
      "Couldn’t check for uncommitted changes",
    );
  });
});
