import { describe, it, expect } from "vitest";
import type { RepoGraph } from "../lib/api";
import {
  buildCommitBatchPlan,
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

describe("buildCommitBatchPlan", () => {
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

describe("isCommitReachableFromRemote", () => {
  it("walks remote refs through their parents", () => {
    const g = graph(["local-head", "remote-tip", "remote-parent"], ["remote-tip"]);
    expect(isCommitReachableFromRemote(g, "local-head")).toBe(false);
    expect(isCommitReachableFromRemote(g, "remote-tip")).toBe(true);
    expect(isCommitReachableFromRemote(g, "remote-parent")).toBe(true);
  });
});
