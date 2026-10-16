import { describe, expect, it } from "vitest";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import type { FileChange, WorkingChanges } from "@/lib/api";
import { includeRows, includeTarget, rollupState } from "./includeList";

const file = (path: string): FileChange => ({ path, status: "M", add: 1, del: 0, binary: false });

const changes = (staged: string[], unstaged: string[]): WorkingChanges => ({
  staged: staged.map(file),
  unstaged: unstaged.map(file),
  conflicted: [],
  advanced: emptyAdvancedState,
});

describe("includeRows", () => {
  it("reads one three-state row per path from the two buckets", () => {
    const rows = includeRows(changes(["a", "b"], ["b", "c"]));
    expect(rows.map((r) => [r.path, r.checked, r.source])).toEqual([
      ["a", true, "staged"],
      ["b", "mixed", "unstaged"],
      ["c", false, "unstaged"],
    ]);
  });
});

describe("rollupState", () => {
  const rows = includeRows(changes(["a/x", "a/y"], ["b/z"]));
  it("is checked only when every file under the folder is", () => {
    expect(rollupState(rows, ["a/x", "a/y"])).toBe(true);
    expect(rollupState(rows, ["b/z"])).toBe(false);
    expect(rollupState(rows, ["a/x", "b/z"])).toBe("mixed");
  });
});

describe("includeTarget", () => {
  const rows = includeRows(changes(["a", "b"], ["b", "c"]));
  it("unstages a fully included selection", () => {
    expect(includeTarget(rows, ["a"])).toEqual({ action: "unstage", paths: ["a"] });
  });
  it("stages whatever is not yet fully included", () => {
    expect(includeTarget(rows, ["a", "b", "c"])).toEqual({ action: "stage", paths: ["b", "c"] });
  });
});
