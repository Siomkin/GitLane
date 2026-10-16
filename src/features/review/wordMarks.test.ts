import { describe, expect, it } from "vitest";
import type { DiffLine } from "@/lib/api";
import { markKey, wordMarks } from "./wordMarks";

const l = (kind: DiffLine["kind"], content: string): DiffLine => ({ kind, oldNo: null, newNo: null, content });

describe("wordMarks", () => {
  it("pairs the k-th removed line with the k-th added line of each run", () => {
    const marks = wordMarks([
      {
        header: "@@ -1,4 +1,4 @@",
        lines: [l("ctx", "x"), l("del", "a + b"), l("del", "keep me"), l("add", "a - b"), l("add", "keep you"), l("ctx", "y")],
      },
    ]);
    expect(marks.get(markKey(0, 1))).toEqual([[2, 3]]);
    expect(marks.get(markKey(0, 3))).toEqual([[2, 3]]);
    expect(marks.get(markKey(0, 4))).toEqual([[5, 8]]);
    expect(marks.has(markKey(0, 0))).toBe(false);
  });

  it("leaves unpaired additions unmarked", () => {
    const marks = wordMarks([{ header: "@@ -1 +1,2 @@", lines: [l("add", "new one"), l("add", "new two")] }]);
    expect(marks.size).toBe(0);
  });
});
