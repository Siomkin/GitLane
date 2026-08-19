import { describe, expect, it } from "vitest";

import type { RepoSummary } from "@/lib/api";
import {
  drawnTabOrder,
  groupRuns,
  groupedInsertIndex,
  moveRun,
  moveWithinRun,
  runKey,
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

describe("custom repository names", () => {
  it("replaces the folder name on a plain repo tab", () => {
    expect(tabDisplay("/dev/acme/frontend", repoInfo, "Acme · frontend")).toEqual({
      kind: "repo",
      name: "Acme · frontend",
    });
    // An empty/absent custom name falls back to the leaf directory.
    expect(tabDisplay("/dev/acme/frontend", repoInfo, "")).toEqual({
      kind: "repo",
      name: "frontend",
    });
    expect(tabDisplay("/dev/acme/frontend", repoInfo, null)).toEqual({
      kind: "repo",
      name: "frontend",
    });
  });

  it("replaces the parent-repo half of a worktree tab", () => {
    const display = tabDisplay("/dev/wt", wtInfo("/dev/acme/frontend", "feat/x"), "Acme");
    expect(display).toEqual({ kind: "worktree", repoName: "Acme", detail: "feat/x" });
    expect(tabLabel("/dev/wt", wtInfo("/dev/acme/frontend", "feat/x"), "Acme")).toBe("Acme · feat/x");
  });
});

/** A run as the assertions below name it: everything expanded and drawn,
 * which is every case but the collapse ones. */
const run = (groupId: string | null, paths: string[]) => ({
  groupId,
  paths,
  collapsed: false,
  drawn: paths,
});

describe("groupRuns", () => {
  const groups: Record<string, string> = { "/a": "acme", "/c": "acme" };
  const groupIdOf = (path: string) => groups[path] ?? null;

  it("pulls a group's later members into the run at its first member", () => {
    // frontend(Acme), notes(ungrouped), backend(Acme) → the Acme run sits where
    // frontend was, and notes follows it.
    expect(groupRuns(["/a", "/b", "/c"], groupIdOf)).toEqual([
      run("acme", ["/a", "/c"]),
      run(null, ["/b"]),
    ]);
  });

  it("is idempotent — the flattened order reproduces the same runs", () => {
    const flattened = groupRuns(["/a", "/b", "/c"], groupIdOf).flatMap((run) => run.paths);
    expect(flattened).toEqual(["/a", "/c", "/b"]);
    expect(groupRuns(flattened, groupIdOf)).toEqual(groupRuns(["/a", "/b", "/c"], groupIdOf));
  });

  it("gives each ungrouped tab its own run, in order", () => {
    expect(groupRuns(["/x", "/y"], () => null)).toEqual([
      run(null, ["/x"]),
      run(null, ["/y"]),
    ]);
    expect(groupRuns([], () => null)).toEqual([]);
  });

  it("orders groups by first appearance", () => {
    const byPath: Record<string, string> = { "/a": "acme", "/p": "personal", "/b": "acme" };
    expect(groupRuns(["/p", "/a", "/b"], (path) => byPath[path] ?? null)).toEqual([
      run("personal", ["/p"]),
      run("acme", ["/a", "/b"]),
    ]);
  });
});

describe("groupRuns — collapsed groups", () => {
  const byPath: Record<string, string> = { "/a1": "acme", "/a2": "acme", "/a3": "acme" };
  const groupIdOf = (path: string) => byPath[path] ?? null;
  const paths = ["/a1", "/notes", "/a2", "/a3"];
  const collapsed = (groupId: string) => groupId === "acme";

  it("draws none of a collapsed group's tabs when the active tab is elsewhere", () => {
    const runs = groupRuns(paths, groupIdOf, { collapsed, activePath: "/notes" });
    expect(runs[0]).toEqual({
      groupId: "acme",
      // Full membership survives — it is what the pill counts and what a drag
      // moves — while nothing of it is drawn.
      paths: ["/a1", "/a2", "/a3"],
      collapsed: true,
      drawn: [],
    });
    expect(runs[1]).toEqual(run(null, ["/notes"]));
  });

  it("still draws the active tab when the collapsed group holds it", () => {
    const runs = groupRuns(paths, groupIdOf, { collapsed, activePath: "/a3" });
    expect(runs[0].paths).toEqual(["/a1", "/a2", "/a3"]);
    expect(runs[0].drawn).toEqual(["/a3"]);
  });

  it("leaves the drawn order without the folded-away tabs", () => {
    expect(drawnTabOrder(paths, groupIdOf, { collapsed, activePath: "/notes" })).toEqual(["/notes"]);
    expect(drawnTabOrder(paths, groupIdOf, { collapsed, activePath: "/a2" })).toEqual([
      "/a2",
      "/notes",
    ]);
    // Expanded, every tab is back in the order — collapsing changed nothing else.
    expect(drawnTabOrder(paths, groupIdOf)).toEqual(["/a1", "/a2", "/a3", "/notes"]);
  });

  it("moves every member of a collapsed run, drawn or not", () => {
    const runs = groupRuns(paths, groupIdOf, { collapsed, activePath: "/notes" });
    expect(moveRun(runs, 0, 1)).toEqual(["/notes", "/a1", "/a2", "/a3"]);
  });

  it("never collapses an ungrouped run", () => {
    const runs = groupRuns(["/x"], () => null, { collapsed: () => true, activePath: null });
    expect(runs[0]).toEqual(run(null, ["/x"]));
  });
});

describe("moveRun / moveWithinRun", () => {
  const runs = [
    run("acme", ["/a1", "/a2"]),
    run(null, ["/notes"]),
    run("personal", ["/p1"]),
  ];

  it("moves a group with all of its tabs", () => {
    expect(moveRun(runs, 0, 2)).toEqual(["/notes", "/p1", "/a1", "/a2"]);
    expect(moveRun(runs, 2, 0)).toEqual(["/p1", "/a1", "/a2", "/notes"]);
  });

  it("moves a lone ungrouped tab between groups without joining one", () => {
    const order = moveRun(runs, 1, 0);
    expect(order).toEqual(["/notes", "/a1", "/a2", "/p1"]);
    // Re-deriving the runs from that order keeps `/notes` ungrouped.
    const groupOf: Record<string, string> = { "/a1": "acme", "/a2": "acme", "/p1": "personal" };
    expect(groupRuns(order, (p) => groupOf[p] ?? null)).toEqual([
      run(null, ["/notes"]),
      run("acme", ["/a1", "/a2"]),
      run("personal", ["/p1"]),
    ]);
  });

  it("reorders inside one group and leaves every other run untouched", () => {
    expect(moveWithinRun(runs, 0, 1, 0)).toEqual(["/a2", "/a1", "/notes", "/p1"]);
  });

  it("returns the unchanged order for an out-of-range move", () => {
    expect(moveRun(runs, 9, 0)).toEqual(["/a1", "/a2", "/notes", "/p1"]);
    expect(moveWithinRun(runs, 0, 9, 0)).toEqual(["/a1", "/a2", "/notes", "/p1"]);
  });

  it("names a run by its group, or by the ungrouped tab it holds", () => {
    expect(runKey(runs[0])).toBe("acme");
    expect(runKey(runs[1])).toBe("ungrouped:/notes");
  });
});
