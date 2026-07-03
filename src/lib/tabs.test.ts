import { describe, expect, it } from "vitest";

import type { RepoSummary } from "@/lib/api";
import {
  groupedInsertIndex,
  pruneTabInfo,
  tabDisplay,
  tabIdentity,
  tabInfoFromStatus,
  tabInfoFromSummary,
  tabLabel,
  type TabInfo,
} from "./tabs";

const wtInfo = (mainPath: string, branch: string | null = null): TabInfo => ({
  isWorktree: true,
  mainPath,
  branch,
});
const repoInfo: TabInfo = { isWorktree: false, mainPath: null, branch: "main" };

describe("tabDisplay / tabLabel", () => {
  it("labels a plain repo tab by its leaf directory", () => {
    expect(tabDisplay("/dev/e-Medicus", repoInfo)).toEqual({ kind: "repo", name: "e-Medicus" });
    // No info at all (tab not yet probed) degrades the same way.
    expect(tabDisplay("/dev/e-Medicus", undefined)).toEqual({ kind: "repo", name: "e-Medicus" });
  });

  it("labels a worktree tab with its parent repo and branch", () => {
    const display = tabDisplay(
      "/dev/e-Medicus/.claude/worktrees/trusting-jackson",
      wtInfo("/dev/e-Medicus", "d/trusting-jackson"),
    );
    expect(display).toEqual({
      kind: "worktree",
      repoName: "e-Medicus",
      detail: "d/trusting-jackson",
    });
    expect(tabLabel("/x", wtInfo("/dev/e-Medicus", "d/trusting-jackson"))).toBe(
      "e-Medicus · d/trusting-jackson",
    );
  });

  it("falls back to the worktree's leaf directory when detached", () => {
    const display = tabDisplay("/wt/scratch-1", wtInfo("/dev/repo", null));
    expect(display).toEqual({ kind: "worktree", repoName: "repo", detail: "scratch-1" });
  });
});

describe("tabIdentity / groupedInsertIndex", () => {
  const infoByPath: Record<string, TabInfo> = {
    "/dev/GitLane": repoInfo,
    "/dev/GitLane/.claude/worktrees/lewin": wtInfo("/dev/GitLane", "d/lewin"),
    "/dev/e-Medicus": repoInfo,
  };

  it("keys a worktree tab to its main checkout and a repo tab to itself", () => {
    expect(tabIdentity("/dev/GitLane", infoByPath["/dev/GitLane"])).toBe("/dev/GitLane");
    expect(
      tabIdentity(
        "/dev/GitLane/.claude/worktrees/lewin",
        infoByPath["/dev/GitLane/.claude/worktrees/lewin"],
      ),
    ).toBe("/dev/GitLane");
  });

  it("inserts a new worktree tab right after its repository's tabs", () => {
    const open = ["/dev/GitLane", "/dev/e-Medicus"];
    expect(groupedInsertIndex(open, infoByPath, "/dev/GitLane")).toBe(1);
    // After the last tab of the group, not the first.
    const openWithWt = [
      "/dev/GitLane",
      "/dev/GitLane/.claude/worktrees/lewin",
      "/dev/e-Medicus",
    ];
    expect(groupedInsertIndex(openWithWt, infoByPath, "/dev/GitLane")).toBe(2);
  });

  it("appends when no open tab shares the repository", () => {
    expect(groupedInsertIndex(["/dev/GitLane"], infoByPath, "/dev/other")).toBe(1);
    expect(groupedInsertIndex([], {}, "/dev/other")).toBe(0);
  });
});

describe("tabInfo mapping + pruning", () => {
  it("maps a summary and a probe status to the same shape", () => {
    const summary: RepoSummary = {
      path: "/wt",
      workdir: "/wt",
      headBranch: "feat",
      headOid: null,
      detached: false,
      isWorktree: true,
      mainPath: "/main",
    };
    expect(tabInfoFromSummary(summary)).toEqual(wtInfo("/main", "feat"));
    expect(
      tabInfoFromStatus({ path: "/wt", exists: true, branch: "feat", isWorktree: true, mainPath: "/main" }),
    ).toEqual(wtInfo("/main", "feat"));
    // Fixture-era summaries without the identity fields degrade to a repo tab.
    expect(
      tabInfoFromSummary({ path: "/r", workdir: "/r", headBranch: "main", headOid: null, detached: false }),
    ).toEqual({ isWorktree: false, mainPath: null, branch: "main" });
  });

  it("drops info for tabs that are no longer open", () => {
    const pruned = pruneTabInfo({ "/a": repoInfo, "/b": repoInfo }, ["/a"]);
    expect(Object.keys(pruned)).toEqual(["/a"]);
  });
});
