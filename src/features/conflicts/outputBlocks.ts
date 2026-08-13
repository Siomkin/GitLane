// Group the Output pane's flat rows into context lines vs per-hunk blocks, so
// a conflict can render as an editable field instead of a stack of read-only
// picked lines.

import type { OutputRow, Token } from "./conflictModel";

export type OutputBlock =
  | { kind: "ctx"; no: number; tokens: Token[] }
  | {
      kind: "hunk";
      regionIdx: number;
      conflictNo: number;
      /** First line number in the merged file — the hunk shares the Output gutter. */
      startNo: number;
      /** No decision yet — an empty field must not count as "dropped both". */
      open: boolean;
      text: string;
    };

/** Collapse consecutive output rows that belong to one conflict into a hunk
 * block; context lines stay one-per-row. */
export function groupOutputBlocks(rows: OutputRow[]): OutputBlock[] {
  const blocks: OutputBlock[] = [];
  let i = 0;
  let conflictNo = 0;
  let nextNo = 1;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === "placeholder") {
      conflictNo = row.conflictNo;
      blocks.push({
        kind: "hunk",
        regionIdx: row.regionIdx,
        conflictNo: row.conflictNo,
        startNo: nextNo,
        open: !row.dropped,
        text: "",
      });
      i += 1;
      continue;
    }
    if (row.removable || row.side === "ai") {
      const regionIdx = row.regionIdx;
      const startNo = row.no;
      const lines: string[] = [];
      while (i < rows.length) {
        const next = rows[i];
        if (next.kind !== "line" || next.regionIdx !== regionIdx) break;
        if (!next.removable && next.side !== "ai") break;
        lines.push(next.text);
        i += 1;
      }
      conflictNo += 1;
      blocks.push({
        kind: "hunk",
        regionIdx,
        conflictNo,
        startNo,
        open: false,
        text: lines.join("\n"),
      });
      nextNo = startNo + lines.length;
      continue;
    }
    blocks.push({ kind: "ctx", no: row.no, tokens: row.tokens });
    nextNo = row.no + 1;
    i += 1;
  }
  return blocks;
}

/** Textarea value → custom-resolution lines. Empty means "keep nothing". */
export function splitOutputLines(text: string): string[] {
  if (text === "") return [];
  return text.split("\n");
}
