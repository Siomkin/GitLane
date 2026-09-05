import { describe, expect, it } from "vitest";
import { type CommitNode, type RepoGraph } from "@/lib/api";
import { otherSquashTargets } from "./squashTargets";

const node = (id: string, parents: string[], refs: CommitNode["refs"] = []): CommitNode => ({
  id, shortId: id, parents, refs, summary: id, body: "", authorName: "", authorEmail: "", timestamp: 0, row: 0, lane: 0,
});
const graph = (): RepoGraph => ({
  head: "current", commits: [
    node("two", ["one"], [{ name: "feature", kind: "branch" }]),
    node("one", ["base"]), node("current", ["base"], [{ name: "main", kind: "branch" }]), node("base", []),
  ], edges: [], laneCount: 2, wipLane: null, truncated: false,
});

describe("other squash targets", () => {
  it("resolves the sibling branch with a captured tip and repo", () => {
    expect(otherSquashTargets(graph(), ["one", "two"], "main", "/repo")).toEqual([
      { branch: "feature", oid: "two", repoPath: "/repo" },
    ]);
  });
  it("returns named alternatives when branches share the selection", () => {
    const g = graph();
    g.commits[0].refs.push({ name: "also", kind: "branch" }, { name: "tag", kind: "tag" });
    expect(otherSquashTargets(g, ["one", "two"], "main", "/repo").map((t) => t.branch)).toEqual(["also", "feature"]);
  });
  it("supports below-tip ranges and detached current HEAD", () => {
    const g = graph();
    g.commits[0].refs = [];
    g.commits.unshift(node("three", ["two"], [{ name: "feature", kind: "branch" }]));
    expect(otherSquashTargets(g, ["one", "two"], null, "/repo")[0].oid).toBe("three");
  });
  it.each(["published", "merge", "missing", "noncontiguous", "root", "duplicate"])("refuses %s selections", (reason) => {
    const g = graph();
    let selection = ["one", "two"];
    if (reason === "published") g.commits[0].refs.push({ name: "origin/feature", kind: "remote" });
    if (reason === "merge") g.commits[0].parents.push("current");
    if (reason === "missing") g.commits = g.commits.filter((n) => n.id !== "one");
    if (reason === "noncontiguous") selection = ["two", "base"];
    if (reason === "root") selection = ["one", "base"];
    if (reason === "duplicate") selection = ["two", "two"];
    expect(otherSquashTargets(g, selection, "main", "/repo")).toEqual([]);
  });
});
