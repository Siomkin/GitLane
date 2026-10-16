import { describe, expect, it } from "vitest";
import type { Difference, FileDiff } from "@/lib/api";
import {
  countsLabel,
  differenceCounts,
  differenceStartingAt,
  filePosition,
  neighbourFile,
  revertUnavailableReason,
  stepDifference,
  wholeFileReason,
} from "./includeDiffModel";

const diff = (inclusion: Difference["inclusion"], hunkIndex = 0, lineStart = 3): Difference => ({
  hunkIndex,
  lineStart,
  lineEnd: lineStart + 1,
  inclusion,
  stage: [],
  unstage: [],
});

const file = (over: Partial<FileDiff> = {}): FileDiff => ({
  path: "a.ts",
  status: "M",
  add: 1,
  del: 1,
  binary: false,
  hunks: [{ header: "@@ -1 +1 @@", lines: [] }],
  truncated: false,
  ...over,
});

describe("file navigation", () => {
  const order = Array.from({ length: 17 }, (_, i) => `f${i + 1}`);
  it("reports the 5/17 position", () => {
    const { index, total } = filePosition(order, "f5");
    expect(`${index + 1}/${total}`).toBe("5/17");
  });
  it("steps to the neighbour and stops at the ends", () => {
    expect(neighbourFile(order, "f5", 1)).toBe("f6");
    expect(neighbourFile(order, "f1", -1)).toBeNull();
    expect(neighbourFile(order, "f17", 1)).toBeNull();
  });
});

describe("stepDifference", () => {
  it("moves within the file", () => {
    expect(stepDifference(3, 0, 1)).toEqual({ kind: "here", index: 1 });
    expect(stepDifference(3, null, -1)).toEqual({ kind: "here", index: 2 });
  });
  it("wraps into the next or previous file at either end", () => {
    expect(stepDifference(3, 2, 1)).toEqual({ kind: "file", edge: "first" });
    expect(stepDifference(3, 0, -1)).toEqual({ kind: "file", edge: "last" });
    expect(stepDifference(0, null, 1)).toEqual({ kind: "file", edge: "first" });
  });
});

describe("counts and reasons", () => {
  it("counts included differences", () => {
    const counts = differenceCounts([diff("included"), diff("excluded"), diff("partial")]);
    expect(countsLabel(counts)).toBe("3 differences, 1 included");
    expect(countsLabel({ total: 1, included: 0 })).toBe("1 difference, 0 included");
  });
  it("offers revert only on excluded differences", () => {
    expect(revertUnavailableReason(diff("excluded"))).toBeNull();
    expect(revertUnavailableReason(diff("included"))).toMatch(/Exclude/);
    expect(revertUnavailableReason(diff("partial"))).toMatch(/staged/);
  });
  it("explains whole-file-only files", () => {
    expect(wholeFileReason(file({ status: "U" }), [])).toMatch(/included as a whole/);
    expect(wholeFileReason(file(), [diff("excluded")])).toBeNull();
    expect(wholeFileReason(file({ hunks: [] }), [])).toBeNull();
  });
  it("finds the difference that starts on a row", () => {
    const ds = [diff("excluded", 0, 3), diff("excluded", 1, 4)];
    expect(differenceStartingAt(ds, 1, [4, 5])).toBe(1);
    expect(differenceStartingAt(ds, 0, [4])).toBe(-1);
  });
});
