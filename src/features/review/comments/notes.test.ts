import { describe, expect, it } from "vitest";
import type { DiffHunk } from "../../../lib/api";
import type { ReviewNote } from "../../../store/ui";
import {
  buildLineMeta,
  buildNote,
  composeAgentMessage,
  rangeLabel,
  refIndex,
  scopeText,
} from "./notes";

const hunk: DiffHunk = {
  header: "@@ -1,3 +1,4 @@",
  lines: [
    { kind: "ctx", oldNo: 1, newNo: 1, content: "context" },
    { kind: "del", oldNo: 2, newNo: null, content: "old line" },
    { kind: "add", oldNo: null, newNo: 2, content: "new line 1" },
    { kind: "add", oldNo: null, newNo: 3, content: "new line 2" },
  ],
};

describe("buildLineMeta", () => {
  it("assigns sequential seq and side/ref per line", () => {
    const lines = buildLineMeta([hunk]);
    expect(lines.map((l) => l.seq)).toEqual([0, 1, 2, 3]);
    // ctx + add use the new (R) side; del uses the old (L) side.
    expect(lines.map((l) => l.ref)).toEqual(["R1", "L2", "R2", "R3"]);
    expect(lines[1].side).toBe("L");
    expect(lines[2].side).toBe("R");
  });

  it("refIndex maps refs back to their seq", () => {
    const idx = refIndex(buildLineMeta([hunk]));
    expect(idx.get("R2")).toBe(2);
    expect(idx.get("L2")).toBe(1);
    expect(idx.get("nope")).toBeUndefined();
  });
});

describe("rangeLabel / scopeText", () => {
  it("collapses a single-line range", () => {
    expect(rangeLabel("R2", "R2")).toBe("R2");
    expect(scopeText("R2", "R2")).toBe("Comment on line R2");
  });
  it("shows both ends for a multi-line range", () => {
    expect(rangeLabel("R2", "R3")).toBe("R2–R3");
    expect(scopeText("R2", "R3")).toBe("Comment on lines R2 to R3");
  });
});

describe("buildNote", () => {
  const lines = buildLineMeta([hunk]);

  it("captures the surface, a multi-line range, joined code, and anchor at the range end", () => {
    const note = buildNote("work", "a.ts", lines, 2, 3, "  please fix  ");
    expect(note.surface).toBe("work");
    expect(note.fromRef).toBe("R2");
    expect(note.toRef).toBe("R3");
    expect(note.lineRef).toBe("R2–R3");
    expect(note.code).toBe("new line 1\nnew line 2");
    expect(note.side).toBe("R");
    expect(note.line).toBe(3);
    expect(note.body).toBe("please fix");
  });

  it("normalises a bottom-up drag to the same range", () => {
    expect(buildNote("work", "a.ts", lines, 3, 2, "x")).toEqual(
      buildNote("work", "a.ts", lines, 2, 3, "x"),
    );
  });

  it("handles a single-line selection", () => {
    const note = buildNote("commit:abc", "a.ts", lines, 1, 1, "note");
    expect(note.surface).toBe("commit:abc");
    expect(note.lineRef).toBe("L2");
    expect(note.code).toBe("old line");
  });
});

describe("composeAgentMessage", () => {
  const note = (over: Partial<ReviewNote>): ReviewNote => ({
    id: "x",
    surface: "work",
    file: "a.ts",
    side: "R",
    line: 2,
    fromRef: "R2",
    toRef: "R2",
    lineRef: "R2",
    code: "code",
    body: "do the thing",
    ...over,
  });

  it("returns empty for no notes", () => {
    expect(composeAgentMessage([])).toBe("");
  });

  it("keeps the single-comment message focused on the review item", () => {
    const msg = composeAgentMessage([note({})], "GL-54-line-staging");
    expect(msg).not.toContain("Please address");
    expect(msg).not.toContain("GL-54-line-staging");
    expect(msg).not.toContain("Review comment");
    expect(msg).toContain("1. a.ts — line R2");
    expect(msg).toContain("Feedback: do the thing");
  });

  it("uses plural wording and range labels for multiple notes, ordered by file/line", () => {
    const msg = composeAgentMessage([
      note({ file: "b.ts", line: 9, fromRef: "R7", toRef: "R9", lineRef: "R7–R9", body: "second" }),
      note({ file: "a.ts", line: 2, body: "first" }),
    ]);
    const first = msg.indexOf("a.ts");
    const second = msg.indexOf("b.ts");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(msg).toContain("2. b.ts — lines R7–R9");
  });
});
