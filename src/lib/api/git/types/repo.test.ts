// Table test for the HeadState derivation — the one ladder every consumer of
// RepoSummary's four head fields should switch on instead of re-deriving.
import { describe, expect, it } from "vitest";
import type { RepoSummary } from "./repo";
import { headStateOf } from "./repo";

const summary: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: "abc123",
  detached: false,
};

describe("headStateOf", () => {
  it("derives each of the four kinds from the raw head fields", () => {
    expect(headStateOf(null)).toEqual({ kind: "none" });
    expect(headStateOf({ ...summary, headBranch: null, detached: true })).toEqual({
      kind: "detached",
      oid: "abc123",
    });
    // Unborn resolves a branch name from HEAD's symbolic target (GL-115).
    expect(headStateOf({ ...summary, headBranch: "master", headOid: null, unborn: true })).toEqual({
      kind: "unborn",
      branch: "master",
    });
    expect(headStateOf(summary)).toEqual({ kind: "branch", branch: "main", oid: "abc123" });
    expect(headStateOf({ ...summary, headBranch: null })).toEqual({ kind: "none" });
  });

  it("lets detached win when a fixture somehow also sets headBranch", () => {
    // The wire type permits detached + headBranch together; the backend never
    // sends it, but the ladder must classify by detached first so consumers
    // can't treat an impossible fixture as a checked-out branch.
    expect(headStateOf({ ...summary, detached: true })).toEqual({
      kind: "detached",
      oid: "abc123",
    });
  });

  it("normalizes nullable raw fields the winning state reads", () => {
    expect(headStateOf({ ...summary, headBranch: null, headOid: null, detached: true })).toEqual({
      kind: "detached",
      oid: "",
    });
    expect(headStateOf({ ...summary, headOid: null })).toEqual({
      kind: "branch",
      branch: "main",
      oid: "",
    });
  });
});
