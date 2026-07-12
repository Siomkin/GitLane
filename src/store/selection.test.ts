import { describe, it, expect } from "vitest";
import type { RepoGraph } from "@/lib/api";
import {
  buildCommitBatchPlan,
  buildSquashMessage,
  computeSelection,
  getSquashEligibility,
  isCommitReachableFromRemote,
  selectionForContextMenu,
  validateSquashRange,
} from "./selection";

// `computeSelection` ranges over exactly the id list it is given, never beyond
// it — so a caller that passes a subset (a view that hides rows) gets a range
// confined to that subset. The History view no longer hides rows (search dims
// non-matches), so it ranges over the full DAG; these tests still pin the
// underlying contract for any view that does pass a narrowed list.
describe("computeSelection — shift range is confined to the provided id list", () => {
  it("ranges over the visible subset, never the hidden commits between them", () => {
    // Full DAG order is a,b,c,d,e but the filter hides b and d.
    const visible = ["a", "c", "e"];
    const res = computeSelection({ ids: visible, selected: ["a"], anchor: "a" }, "e", { shift: true });
    expect(res.selected).toEqual(["a", "c", "e"]);
    expect(res.selected).not.toContain("b");
    expect(res.selected).not.toContain("d");
  });

  it("contrast: the same shift over the full order would include the hidden ones", () => {
    const full = ["a", "b", "c", "d", "e"];
    const res = computeSelection({ ids: full, selected: ["a"], anchor: "a" }, "e", { shift: true });
    expect(res.selected).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("falls back to single-select when the anchor was filtered out of the list", () => {
    const res = computeSelection({ ids: ["a", "c", "e"], selected: ["b"], anchor: "b" }, "e", { shift: true });
    expect(res.selected).toEqual(["e"]);
    expect(res.anchor).toBe("e");
  });
});

const graph = (ids: string[], remoteTips: string[] = []): RepoGraph => ({
  commits: ids.map((id, index) => ({
    id,
    shortId: id,
    summary: id,
    body: "",
    authorName: "",
    authorEmail: "",
    timestamp: 0,
    parents: index === ids.length - 1 ? ["parent-of-oldest"] : [ids[index + 1]],
    lane: 0,
    row: index,
    color: 0,
    refs: remoteTips.includes(id) ? [{ name: `origin/${id}`, kind: "remote" }] : [],
  })),
  edges: [],
  laneCount: 1,
  head: ids[0] ?? null,
  truncated: false,
});

// Two first-parent commits (A → B) with an in-window stash node interleaved
// between them — the shape the Rust layout now produces (commit, stash, commit).
const graphWithInterleavedStash = (): RepoGraph => ({
  commits: [
    { id: "A", shortId: "A", summary: "A", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: ["B"], lane: 0, row: 0, color: 0, refs: [] },
    { id: "s0", shortId: "s0", summary: "WIP", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: ["A"], lane: 1, row: 1, color: 1, refs: [], stash: { index: 0, message: "WIP" } },
    { id: "B", shortId: "B", summary: "B", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: ["parent-of-B"], lane: 0, row: 2, color: 0, refs: [] },
  ],
  edges: [],
  laneCount: 2,
  head: "A",
  truncated: false,
});

describe("buildCommitBatchPlan", () => {
  it("treats commits straddling an injected stash node as one contiguous range", () => {
    // A and B are first-parent adjacent but a stash node sits between them in
    // graph.commits; contiguity must ignore the stash node, not split the range.
    const plan = buildCommitBatchPlan(graphWithInterleavedStash(), ["A", "B"]);
    expect(plan.compareRange).toEqual({ base: "parent-of-B", head: "A" });
  });

  it("cherry-picks oldest-first, reverts newest-first, and includes the oldest change", () => {
    const plan = buildCommitBatchPlan(graph(["newest", "middle", "oldest"]), [
      "newest",
      "middle",
      "oldest",
    ]);
    expect(plan.cherryPickOrder).toEqual(["oldest", "middle", "newest"]);
    expect(plan.revertOrder).toEqual(["newest", "middle", "oldest"]);
    expect(plan.compareRange).toEqual({ base: "parent-of-oldest", head: "newest" });
  });

  it("does not pretend a disjoint additive selection is one compare range", () => {
    const plan = buildCommitBatchPlan(graph(["a", "b", "c"]), ["a", "c"]);
    expect(plan.compareRange).toBeNull();
  });

  it("does not treat adjacent rows from different ancestry paths as one range", () => {
    const branched = graph(["a", "b", "c"]);
    branched.commits[0].parents = ["c"];
    const plan = buildCommitBatchPlan(branched, ["a", "b"]);
    expect(plan.compareRange).toBeNull();
  });
});

describe("selectionForContextMenu", () => {
  it("preserves a multi-selection when right-clicking one of its commits", () => {
    const selected = ["a", "b"];
    expect(selectionForContextMenu(selected, "b")).toBe(selected);
  });

  it("targets only a newly right-clicked commit", () => {
    expect(selectionForContextMenu(["a", "b"], "c")).toEqual(["c"]);
  });
});

describe("getSquashEligibility", () => {
  it("squashes a contiguous range that straddles an injected stash node", () => {
    expect(getSquashEligibility(graphWithInterleavedStash(), ["A", "B"])).toEqual({
      ok: true,
      parent: "parent-of-B",
    });
  });

  it("allows a contiguous unpublished range ending at HEAD", () => {
    const g = graph(["newest", "middle", "oldest", "base"]);
    expect(getSquashEligibility(g, ["newest", "middle"])).toEqual({
      ok: true,
      parent: "oldest",
    });
    expect(validateSquashRange(g, ["newest", "middle"])).toBe("oldest");
  });

  it("rejects selections that do not end at HEAD", () => {
    expect(getSquashEligibility(graph(["head", "middle", "oldest"]), ["middle", "oldest"])).toEqual({
      ok: false,
      reason: "Can only squash commits ending at the branch tip (HEAD)",
    });
  });

  it("rejects commits already reachable from a remote ref", () => {
    expect(getSquashEligibility(graph(["head", "middle", "oldest"], ["head"]), ["head", "middle"])).toEqual({
      ok: false,
      reason: "Can only squash commits that have not been pushed",
    });
  });

  it("allows local commits above the remote tip", () => {
    expect(getSquashEligibility(graph(["head", "middle", "origin-tip"], ["origin-tip"]), ["head", "middle"])).toEqual({
      ok: true,
      parent: "origin-tip",
    });
  });
});

describe("buildSquashMessage", () => {
  // A newest-first graph carrying real summaries + bodies, like the Rust layout.
  const rich = (): RepoGraph => ({
    commits: [
      { id: "c", shortId: "c", summary: "feat: newest", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: ["b"], lane: 0, row: 0, color: 0, refs: [] },
      { id: "b", shortId: "b", summary: "fix: middle", body: "details", authorName: "", authorEmail: "", timestamp: 0, parents: ["a"], lane: 0, row: 1, color: 0, refs: [] },
      { id: "a", shortId: "a", summary: "feat: oldest", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: ["base"], lane: 0, row: 2, color: 0, refs: [] },
    ],
    edges: [],
    laneCount: 1,
    head: "c",
    truncated: false,
  });

  it("concatenates the selected messages oldest-first so the subject stays valid", () => {
    // Passed newest-first (as the menu does); graph order drives the output.
    expect(buildSquashMessage(rich(), ["c", "b", "a"])).toBe(
      "feat: oldest\n\nfix: middle\n\ndetails\n\nfeat: newest",
    );
  });

  it("only includes the selected commits", () => {
    expect(buildSquashMessage(rich(), ["c", "b"])).toBe("fix: middle\n\ndetails\n\nfeat: newest");
  });

  it("returns an empty string for an empty selection or missing graph", () => {
    expect(buildSquashMessage(rich(), [])).toBe("");
    expect(buildSquashMessage(null, ["c"])).toBe("");
  });
});

describe("isCommitReachableFromRemote", () => {
  it("walks remote refs through their parents", () => {
    const g = graph(["local-head", "remote-tip", "remote-parent"], ["remote-tip"]);
    expect(isCommitReachableFromRemote(g, "local-head")).toBe(false);
    expect(isCommitReachableFromRemote(g, "remote-tip")).toBe(true);
    expect(isCommitReachableFromRemote(g, "remote-parent")).toBe(true);
  });
});
