import { describe, it, expect } from "vitest";
import type { CommitNode, RefLabel } from "../../lib/api";
import { commitMatches, isFiltering, matchingIds } from "./historyFilter";

let seq = 0;
function commit(over: Partial<CommitNode> = {}): CommitNode {
  seq += 1;
  return {
    id: `oid${seq}`,
    shortId: `oid${seq}`.slice(0, 7),
    summary: "",
    body: "",
    authorName: "",
    authorEmail: "",
    timestamp: 0,
    parents: ["p1"],
    lane: 0,
    row: 0,
    color: 0,
    refs: [],
    ...over,
  };
}
const ref = (name: string, kind: RefLabel["kind"]): RefLabel => ({ name, kind });
/** matchingIds returns a Set of ids; assert which commits matched by id. */
const ids = (set: Set<string> | null) => (set === null ? null : [...set]);

describe("isFiltering", () => {
  it("is false only when query is blank and filter is all", () => {
    expect(isFiltering("", "all")).toBe(false);
    expect(isFiltering("   ", "all")).toBe(false);
    expect(isFiltering("fix", "all")).toBe(true);
    expect(isFiltering("", "merges")).toBe(true);
  });
});

describe("matchingIds — inert", () => {
  it("returns null when nothing is narrowing (so callers skip dimming)", () => {
    const all = [commit(), commit()];
    expect(matchingIds(all, "", "all")).toBeNull();
    expect(matchingIds(all, "   ", "all")).toBeNull();
  });
});

describe("matchingIds — kind filter", () => {
  const regular = commit({ parents: ["p1"] });
  const root = commit({ parents: [] });
  const merge = commit({ parents: ["p1", "p2"] });
  const tagged = commit({ parents: ["p1"], refs: [ref("v1.0.0", "tag")] });
  const all = [regular, root, merge, tagged];

  it("'commits' matches non-merge commits (incl. root), not merges", () => {
    expect(ids(matchingIds(all, "", "commits"))).toEqual([regular.id, root.id, tagged.id]);
  });

  it("'merges' matches only multi-parent commits", () => {
    expect(ids(matchingIds(all, "", "merges"))).toEqual([merge.id]);
  });

  it("'tags' matches only commits carrying a tag ref", () => {
    expect(ids(matchingIds(all, "", "tags"))).toEqual([tagged.id]);
  });
});

describe("matchingIds — query", () => {
  const byMsg = commit({ summary: "Fix the crash on launch" });
  const bySha = commit({ id: "deadbeefcafe", shortId: "deadbee" });
  const byAuthor = commit({ authorName: "Ada Lovelace", authorEmail: "ada@example.com" });
  const byBranch = commit({ refs: [ref("feat/search", "branch")] });
  const all = [byMsg, bySha, byAuthor, byBranch];

  it("matches message text case-insensitively", () => {
    expect(ids(matchingIds(all, "CRASH", "all"))).toEqual([byMsg.id]);
  });

  it("matches a SHA prefix", () => {
    expect(ids(matchingIds(all, "deadbee", "all"))).toEqual([bySha.id]);
  });

  it("matches author name and email", () => {
    expect(ids(matchingIds(all, "lovelace", "all"))).toEqual([byAuthor.id]);
    expect(ids(matchingIds(all, "ada@example", "all"))).toEqual([byAuthor.id]);
  });

  it("matches a branch ref name", () => {
    expect(ids(matchingIds(all, "feat/search", "all"))).toEqual([byBranch.id]);
  });

  it("returns an empty set (not null) when an active search matches nothing", () => {
    expect(ids(matchingIds(all, "no-such-thing", "all"))).toEqual([]);
  });

  it("combines query and kind filter (both must match)", () => {
    const m = commit({ summary: "Merge branch", parents: ["a", "b"] });
    const c = commit({ summary: "Merge note", parents: ["a"] });
    expect(ids(matchingIds([m, c], "merge", "merges"))).toEqual([m.id]);
  });
});

describe("commitMatches", () => {
  it("requires both the kind filter and the (pre-lowercased) query to pass", () => {
    const m = commit({ summary: "Merge branch", parents: ["a", "b"] });
    expect(commitMatches(m, "merge", "merges")).toBe(true);
    expect(commitMatches(m, "merge", "commits")).toBe(false); // wrong kind
    expect(commitMatches(m, "nope", "merges")).toBe(false); // query miss
  });
});
