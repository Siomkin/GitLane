import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { BranchInfo, CommitNode, RepoGraph, StashEntry, WorktreeInfo } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useNavigatorSections } from "./useNavigatorSections";

const branch = (name: string, kind: BranchInfo["kind"], target = "c1"): BranchInfo => ({
  name,
  kind,
  target,
  isHead: false,
  upstream: null,
  remote: null,
});
const commit = (over: Partial<CommitNode>): CommitNode => ({
  id: "c1",
  shortId: "c1",
  summary: "",
  body: "",
  authorName: "",
  authorEmail: "",
  timestamp: 0,
  parents: [],
  lane: 0,
  row: 0,
  color: 0,
  refs: [],
  ...over,
});
// A commit carrying a tag ref — tags are derived from the graph, not a branch list.
const tagged = commit({ id: "c1", refs: [{ name: "v1.0.0", kind: "tag" }] });
const graph: RepoGraph = { commits: [tagged], edges: [], laneCount: 1, head: "c1", truncated: false };
const worktree: WorktreeInfo = { name: "wt", path: "/wt", branch: "feature/search", isMain: false };
const stash: StashEntry = { index: 0, message: "wip on main", oid: "s1", timestamp: 0, baseOid: "c1", baseTimestamp: 0, context: [] };

function seed(over: Partial<Parameters<typeof useRepo.setState>[0]> = {}) {
  useRepo.setState({
    summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
    graph,
    branches: [branch("main", "local"), branch("feature/search", "local"), branch("origin/main", "remote")],
    worktrees: [worktree],
    stashes: [stash],
    ...over,
  });
}

const render = (filter: string) => renderHook(() => useNavigatorSections(filter)).result.current;

beforeEach(() => {
  seed();
  useUi.setState({ pinnedNavRefs: {} });
});

describe("useNavigatorSections", () => {
  it("returns every item with match=true and no active filter when the query is blank", () => {
    const s = render("");
    expect(s.filtering).toBe(false);
    expect(s.isEmpty).toBe(false);
    expect(s.hasMatches).toBe(false); // gated on `filtering` — meaningless when inert
    expect(s.locals.items.map((b) => b.name)).toEqual(["main", "feature/search"]); // current sorts first
    expect(s.locals.items.every((b) => b.match)).toBe(true);
    expect(s.remotes.items.every((b) => b.match)).toBe(true);
    expect(s.tags.items.every((t) => t.match)).toBe(true);
    expect(s.worktrees.items.every((w) => w.match)).toBe(true);
    expect(s.stashes.items.every((st) => st.match)).toBe(true);
  });

  it("returns only matching rows when filtering", () => {
    const s = render("feature");
    expect(s.filtering).toBe(true);
    expect(s.hasMatches).toBe(true);
    expect(s.locals.items.map((b) => b.name)).toEqual(["feature/search"]);
    expect(s.locals.items.find((b) => b.name === "feature/search")?.match).toBe(true);
    // The worktree's branch (feature/search) matches; the stash message does not.
    expect(s.worktrees.items[0].match).toBe(true);
    expect(s.stashes.items).toEqual([]);
    expect(s.tags.items).toEqual([]);
  });

  it("reports hasMatches=false and returns no visible rows when nothing matches", () => {
    const s = render("zzz-nope");
    expect(s.filtering).toBe(true);
    expect(s.hasMatches).toBe(false);
    expect(s.isEmpty).toBe(false);
    expect(s.locals.items).toEqual([]);
    expect(s.remotes.items).toEqual([]);
    expect(s.worktrees.items).toEqual([]);
    expect(s.stashes.items).toEqual([]);
  });

  it("matches a tag by its name (tags come from the graph)", () => {
    expect(render("v1.0").tags.items[0].match).toBe(true);
  });

  it("matches a worktree by a fragment of its path (shown as the row's secondary text)", () => {
    seed({ worktrees: [{ name: "wt", path: "/work/acme-wt-feature", branch: "feature/search", isMain: false }] });
    // "acme-wt" appears only in the path — not the branch or directory name.
    const s = render("acme-wt");
    expect(s.worktrees.items).toHaveLength(1);
    expect(s.worktrees.items[0].match).toBe(true);
  });

  it("resolves a worktree's oid from its branch tip", () => {
    const s = render("");
    expect(s.worktrees.items[0].oid).toBe("c1");
  });

  it("resolves a detached worktree's oid from its HEAD commit", () => {
    // No branch to resolve through — the porcelain HEAD oid is the only anchor.
    seed({ worktrees: [{ name: "wt", path: "/wt", branch: null, head: "c1", isMain: false }] });
    const s = render("");
    expect(s.worktrees.items[0].oid).toBe("c1");
    // Detached ⇒ the row label falls back to the directory name.
    expect(s.worktrees.items[0].label).toBe("wt");
  });

  it("flags a local branch checked out in a non-active worktree with that worktree's name", () => {
    const s = render("");
    // feature/search is checked out in the linked worktree "wt" (path /wt).
    expect(s.locals.items.find((b) => b.name === "feature/search")?.worktree).toBe("wt");
    // The head branch lives in the open worktree (/r), so it isn't flagged.
    expect(s.locals.items.find((b) => b.name === "main")?.worktree).toBeNull();
  });

  it("sorts pinned rows above unpinned — current always first — and marks the separator", () => {
    seed({
      branches: [
        branch("alpha", "local"),
        branch("main", "local"),
        branch("zulu", "local"),
        branch("origin/main", "remote"),
      ],
    });
    useUi.setState({ pinnedNavRefs: { "local|zulu": true } });
    const s = render("");
    expect(s.locals.items.map((b) => b.name)).toEqual(["main", "zulu", "alpha"]);
    expect(s.locals.items.map((b) => b.pinned)).toEqual([false, true, false]);
    // The hairline sits before the first unpinned row (index 2).
    expect(s.locals.separatorAt).toBe(2);
    // No pins in remotes → no separator.
    expect(s.remotes.separatorAt).toBeNull();
  });

  it("keeps section totals at the unfiltered size while filtering", () => {
    const s = render("feature");
    expect(s.locals.items).toHaveLength(1);
    expect(s.locals.total).toBe(2);
    expect(s.remotes.total).toBe(1);
  });

  it("reports isEmpty for a repo with no refs/worktrees/stashes", () => {
    seed({ branches: [], worktrees: [], stashes: [], graph: { ...graph, commits: [] } });
    const s = render("anything");
    expect(s.isEmpty).toBe(true);
    expect(s.hasMatches).toBe(false);
  });
});
