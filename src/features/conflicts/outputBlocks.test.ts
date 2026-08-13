import { describe, expect, it } from "vitest";

import { buildLineEditor, parseConflict } from "./conflictModel";
import { groupOutputBlocks, splitOutputLines } from "./outputBlocks";

const ONE = ["head", "<<<<<<< HEAD", "a1", "=======", "b1", ">>>>>>> x", "tail", ""].join("\n");

describe("groupOutputBlocks", () => {
  it("keeps context as individual rows and an open hunk as an editable block", () => {
    const editor = buildLineEditor(parseConflict(ONE), () => new Set());
    expect(groupOutputBlocks(editor.outRows)).toEqual([
      { kind: "ctx", no: 1, tokens: expect.any(Array) },
      { kind: "hunk", regionIdx: 1, conflictNo: 1, startNo: 2, open: true, text: "" },
      { kind: "ctx", no: 2, tokens: expect.any(Array) },
    ]);
  });

  it("joins picked lines into one hunk so the output can be edited as text", () => {
    const editor = buildLineEditor(parseConflict(ONE), (idx) =>
      idx === 1 ? new Set(["a:0", "b:0"]) : new Set(),
    );
    const hunk = groupOutputBlocks(editor.outRows).find((b) => b.kind === "hunk");
    expect(hunk).toEqual({
      kind: "hunk",
      regionIdx: 1,
      conflictNo: 1,
      startNo: 2,
      open: false,
      text: "a1\nb1",
    });
  });

  it("joins a custom rewrite the same way", () => {
    const editor = buildLineEditor(parseConflict(ONE), () => new Set(), (idx) =>
      idx === 1 ? ["merged"] : undefined,
    );
    const hunk = groupOutputBlocks(editor.outRows).find((b) => b.kind === "hunk");
    expect(hunk).toMatchObject({ open: false, text: "merged" });
  });

  it("round-trips a blank line as blank, not a space", () => {
    // tokenize("") inserts a spacer glyph for layout. Feeding that back into
    // the textarea turned a newline into " \n", React reset the value, and
    // Delete/Backspace jumped the caret to EOF.
    const editor = buildLineEditor(parseConflict(ONE), () => new Set(), (idx) =>
      idx === 1 ? ["TIMEOUT = 30", "", "BACKOFF = 1.5"] : undefined,
    );
    const hunk = groupOutputBlocks(editor.outRows).find((b) => b.kind === "hunk");
    expect(hunk).toMatchObject({ open: false, text: "TIMEOUT = 30\n\nBACKOFF = 1.5" });
  });

  it("numbers a hunk in the same sequence as the surrounding Output lines", () => {
    const file = ["{", "<<<<<<< HEAD", '"a": 1', "=======", '"a": 2', ">>>>>>> x", "}", ""].join(
      "\n",
    );
    const editor = buildLineEditor(parseConflict(file), (idx) =>
      idx === 1 ? new Set(["b:0"]) : new Set(),
    );
    expect(groupOutputBlocks(editor.outRows)).toEqual([
      { kind: "ctx", no: 1, tokens: expect.any(Array) },
      { kind: "hunk", regionIdx: 1, conflictNo: 1, startNo: 2, open: false, text: '"a": 2' },
      { kind: "ctx", no: 3, tokens: expect.any(Array) },
    ]);
  });
});

describe("splitOutputLines", () => {
  it("treats an empty field as dropped, not a blank line", () => {
    expect(splitOutputLines("")).toEqual([]);
    expect(splitOutputLines("a\nb")).toEqual(["a", "b"]);
    expect(splitOutputLines("a\n")).toEqual(["a", ""]);
  });
});
