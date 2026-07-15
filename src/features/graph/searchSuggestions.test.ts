import { describe, expect, it } from "vitest";
import { BranchKind, RefKind, type BranchInfo, type CommitNode } from "@/lib/api";
import {
  MAX_SUGGESTIONS,
  authorSuggestions,
  completeRevision,
  revisionSuggestions,
} from "./searchSuggestions";

const commit = (over: Partial<CommitNode>): CommitNode =>
  ({ refs: [], authorName: "", authorEmail: "", ...over }) as CommitNode;
const branch = (name: string, kind: BranchKind): BranchInfo => ({ name, kind }) as BranchInfo;

describe("authorSuggestions", () => {
  const commits = [
    commit({ authorName: "Ann Dev", authorEmail: "ann@x.dev" }),
    commit({ authorName: "Ann Dev", authorEmail: "ann@x.dev" }), // dedup
    commit({ authorName: "Bob Ops", authorEmail: "bob@y.io" }),
  ];

  it("dedupes authors and keeps newest-first order", () => {
    expect(authorSuggestions(commits, "")).toEqual([
      { value: "Ann Dev", label: "Ann Dev", hint: "ann@x.dev" },
      { value: "Bob Ops", label: "Bob Ops", hint: "bob@y.io" },
    ]);
  });

  it("matches the query against name and email, case-insensitively", () => {
    expect(authorSuggestions(commits, "BOB").map((i) => i.value)).toEqual(["Bob Ops"]);
    expect(authorSuggestions(commits, "y.io").map((i) => i.value)).toEqual(["Bob Ops"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      commit({ authorName: `Dev ${i}`, authorEmail: `d${i}@x` }),
    );
    expect(authorSuggestions(many, "")).toHaveLength(MAX_SUGGESTIONS);
  });
});

describe("revisionSuggestions", () => {
  const branches = [
    branch("origin/latest", BranchKind.Remote),
    branch("latest", BranchKind.Local),
    branch("feat/search", BranchKind.Local),
  ];
  const commits = [commit({ refs: [{ name: "v1.2.0", kind: RefKind.Tag }] })];

  it("lists local branches, then remotes, tags, and HEAD when empty", () => {
    expect(revisionSuggestions(branches, commits, "").map((i) => i.value)).toEqual([
      "latest",
      "feat/search",
      "origin/latest",
      "v1.2.0",
      "HEAD",
    ]);
  });

  it("filters on the token after the last '..' so ranges complete", () => {
    const items = revisionSuggestions(branches, commits, "latest..feat");
    expect(items.map((i) => i.value)).toEqual(["feat/search"]);
  });
});

describe("completeRevision", () => {
  it("replaces the whole value when there is no range", () => {
    expect(completeRevision("lat", "latest")).toBe("latest");
  });

  it("completes only the token after the last '..'", () => {
    expect(completeRevision("latest..feat", "feat/search")).toBe("latest..feat/search");
    expect(completeRevision("latest..", "HEAD")).toBe("latest..HEAD");
  });
});
