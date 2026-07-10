// Tone sequences feeding the change minimap (GL-162): one entry per rendered
// row, in paint order, so minimap band positions match the scroll height.
import { describe, expect, it } from "vitest";

import type { DiffHunk, DiffLine } from "../../lib/api";
import { splitTones, unifiedTones } from "./diffTones";

const line = (kind: DiffLine["kind"], content = "x"): DiffLine =>
  ({ kind, content, oldNo: kind === "add" ? null : 1, newNo: kind === "del" ? null : 1 }) as DiffLine;

const hunk = (lines: DiffLine[]): DiffHunk => ({ header: "@@", lines }) as DiffHunk;

describe("unifiedTones", () => {
  it("emits a header per hunk then each line's kind in order", () => {
    const hunks = [
      hunk([line("ctx"), line("del"), line("add")]),
      hunk([line("add")]),
    ];
    expect(unifiedTones(hunks)).toEqual(["header", "ctx", "del", "add", "header", "add"]);
    expect(unifiedTones([])).toEqual([]);
  });
});

describe("splitTones", () => {
  it("tones each split row by its dominant side (add wins over del, else ctx)", () => {
    // del+add pair up into one split row → the right side's "add" wins;
    // a lone del rows as "del"; ctx rows as "ctx".
    const hunks = [hunk([line("ctx"), line("del"), line("add"), line("del")])];
    expect(splitTones(hunks)).toEqual(["header", "ctx", "add", "del"]);
  });

  it("matches the unified row count only when no lines pair up", () => {
    const hunks = [hunk([line("ctx"), line("ctx")])];
    expect(splitTones(hunks)).toEqual(unifiedTones(hunks));
  });
});
