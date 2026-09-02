import { describe, expect, it } from "vitest";
import { BranchKind, RefKind } from "@/lib/api";
import { inspectParentRange, inspectParentRangeFromGraph, parentInspectLabel } from "./inspectParent";

describe("inspectParentRange", () => {
  it("returns null for the first parent so callers keep commit_files", () => {
    expect(inspectParentRange(["p0", "p1"], "merge", 0)).toBeNull();
  });

  it("pairs a later parent with the merge oid", () => {
    expect(inspectParentRange(["p0", "p1"], "merge", 1)).toEqual({ base: "p1", head: "merge" });
  });

  it("returns null when the index or merge oid is missing", () => {
    expect(inspectParentRange(["p0"], "merge", 1)).toBeNull();
    expect(inspectParentRange(["p0", "p1"], null, 1)).toBeNull();
  });
});

describe("inspectParentRangeFromGraph", () => {
  it("reads parents off the merge node", () => {
    const graph = { commits: [{ id: "merge", parents: ["feat", "develop"] }] };
    expect(inspectParentRangeFromGraph(graph, "merge", 1)).toEqual({
      base: "develop",
      head: "merge",
    });
  });
});

describe("parentInspectLabel", () => {
  it("prefers a local branch name over a remote-tracking name", () => {
    expect(
      parentInspectLabel("abc1234ffff", [
        { kind: BranchKind.Remote, name: "origin/develop", target: "abc1234ffff" },
        { kind: BranchKind.Local, name: "develop", target: "abc1234ffff" },
      ]),
    ).toBe("abc1234 · develop");
  });

  it("falls back to a remote-tracking name, then a tag", () => {
    expect(
      parentInspectLabel("deadbeef000", [
        { kind: BranchKind.Remote, name: "origin/develop", target: "deadbeef000" },
      ]),
    ).toBe("deadbee · origin/develop");
    expect(
      parentInspectLabel("cafebabef00", [], [{ kind: RefKind.Tag, name: "v1.2" }]),
    ).toBe("cafebab · v1.2");
  });

  it("is short-sha-only when nothing points at the parent", () => {
    expect(parentInspectLabel("abcdef12345", [])).toBe("abcdef1");
  });
});
