import { describe, expect, it } from "vitest";
import type { DiffHunk, DiffLine } from "@/lib/api";
import { flattenSplit, flattenUnified, toSplitRows } from "./diffRows";

const line = (
  kind: DiffLine["kind"],
  content: string,
  oldNo: number | null,
  newNo: number | null,
): DiffLine => ({ kind, content, oldNo, newNo });

const hunk = (header: string, lines: DiffLine[]): DiffHunk => ({ header, lines });

describe("flattenUnified", () => {
  it("emits a header row then one row per line, in order, with unique keys", () => {
    const rows = flattenUnified([
      hunk("@@ -1,2 +1,2 @@", [
        line("ctx", "a", 1, 1),
        line("del", "b", 2, null),
        line("add", "B", null, 2),
      ]),
      hunk("@@ -10 +10 @@", [line("ctx", "c", 10, 10)]),
    ]);

    expect(rows.map((r) => r.kind)).toEqual([
      "header",
      "line",
      "line",
      "line",
      "header",
      "line",
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(rows[0]).toMatchObject({ kind: "header", header: "@@ -1,2 +1,2 @@", hunkIndex: 0 });
    expect(rows[2]).toMatchObject({ kind: "line", hunkIndex: 0, lineIndex: 1 });
    expect(rows[4]).toMatchObject({ kind: "header", header: "@@ -10 +10 @@", hunkIndex: 1 });
  });
});

describe("toSplitRows", () => {
  it("mirrors context and pairs deletions with additions", () => {
    const rows = toSplitRows([
      line("ctx", "x", 1, 1),
      line("del", "old", 2, null),
      line("add", "new", null, 2),
      line("del", "gone", 3, null),
      line("add", "a", null, 3),
      line("add", "b", null, 4),
    ]);

    expect(rows).toHaveLength(4);
    expect([rows[0].left?.line.content, rows[0].right?.line.content]).toEqual(["x", "x"]);
    expect([rows[1].left?.line.content, rows[1].right?.line.content]).toEqual(["old", "new"]);
    expect([rows[1].left?.lineIndex, rows[1].right?.lineIndex]).toEqual([1, 2]);
    expect([rows[2].left?.line.content, rows[2].right?.line.content]).toEqual(["gone", "a"]);
    // The extra addition has no deletion to pair with → blank left half.
    expect(rows[3].left).toBeNull();
    expect(rows[3].right?.line.content).toBe("b");
    expect(rows[3].right?.lineIndex).toBe(5);
  });
});

describe("flattenSplit", () => {
  it("emits a header row then one row per paired split row", () => {
    const rows = flattenSplit([
      hunk("@@ -1 +1 @@", [line("del", "old", 1, null), line("add", "new", null, 1)]),
    ]);

    expect(rows.map((r) => r.kind)).toEqual(["header", "row"]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(rows[0]).toMatchObject({ kind: "header", hunkIndex: 0 });
    expect(rows[1]).toMatchObject({ kind: "row", hunkIndex: 0 });
  });
});
