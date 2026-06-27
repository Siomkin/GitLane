// Pure flattening of a file's hunks into a single positional row list, so the
// diff bodies can be windowed (one virtual row per header/line) instead of
// mounting every line. Kept free of React/DOM so the row math is unit-testable.

import type { DiffHunk, DiffLine } from "../../lib/api";

/** One side of a split-view row, preserving the original hunk line index so
 * line-level write actions can address the backend diff state precisely. */
export type SplitCell = { line: DiffLine; lineIndex: number };

/** A split-view row: a deletion on the left paired with its addition on the
 * right (either side may be absent for a pure add/del). */
export type SplitRow = { left: SplitCell | null; right: SplitCell | null };

/** One flattened row of a unified diff: a hunk header or a single line. Header
 * rows carry the hunk's `changed`-line count (for the header label); line rows
 * carry a file-global `seq` for comment range addressing. */
export type UnifiedRow =
  | { kind: "header"; header: string; hunkIndex: number; changed: number; key: string }
  | { kind: "line"; line: DiffLine; hunkIndex: number; lineIndex: number; seq: number; key: string };

/** One flattened row of a split diff: a hunk header or a left/right pair. Each
 * half carries its own column seq (`leftSeq` for a deletion, `rightSeq` for an
 * addition/context), so the two sides are commented independently; a seq is null
 * when that half isn't commentable on this row. */
export type SplitDiffRow =
  | { kind: "header"; header: string; hunkIndex: number; changed: number; key: string }
  | {
      kind: "row";
      row: SplitRow;
      hunkIndex: number;
      leftSeq: number | null;
      rightSeq: number | null;
      key: string;
    };

/** Flatten hunks into header + line rows, in render order. Keys are stable for
 * a given diff so the virtualizer can track rows across re-renders. */
export function flattenUnified(hunks: DiffHunk[]): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  let seq = 0;
  hunks.forEach((hunk, h) => {
    const changed = hunk.lines.reduce((n, line) => (line.kind === "ctx" ? n : n + 1), 0);
    rows.push({ kind: "header", header: hunk.header, hunkIndex: h, changed, key: `h${h}` });
    hunk.lines.forEach((line, l) =>
      rows.push({ kind: "line", line, hunkIndex: h, lineIndex: l, seq: seq++, key: `h${h}l${l}` }),
    );
  });
  return rows;
}

// Pair deletions with their corresponding additions so a modified line shows
// the old text on the left and the new text on the right of the *same* row.
// Context lines mirror on both sides; a pure add/del leaves the opposite half
// blank.
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind === "ctx") {
      const cell = { line: lines[i], lineIndex: i };
      rows.push({ left: cell, right: cell });
      i++;
      continue;
    }
    const dels: SplitCell[] = [];
    const adds: SplitCell[] = [];
    while (i < lines.length && lines[i].kind === "del") {
      dels.push({ line: lines[i], lineIndex: i });
      i++;
    }
    while (i < lines.length && lines[i].kind === "add") {
      adds.push({ line: lines[i], lineIndex: i });
      i++;
    }
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}

/** Flatten hunks into header + paired split rows, in render order. */
export function flattenSplit(hunks: DiffHunk[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  // Global line offset of the current hunk, so a half's seq indexes the shared
  // `buildLineMeta` list (a deletion comments on the left, an addition/context on
  // the right — context is handled on the right only to avoid a duplicate handle).
  let base = 0;
  hunks.forEach((hunk, h) => {
    const changed = hunk.lines.reduce((n, line) => (line.kind === "ctx" ? n : n + 1), 0);
    rows.push({ kind: "header", header: hunk.header, hunkIndex: h, changed, key: `h${h}` });
    toSplitRows(hunk.lines).forEach((row, r) => {
      const leftSeq = row.left && row.left.line.kind === "del" ? base + row.left.lineIndex : null;
      const rightSeq = row.right ? base + row.right.lineIndex : null;
      rows.push({ kind: "row", row, hunkIndex: h, leftSeq, rightSeq, key: `h${h}r${r}` });
    });
    base += hunk.lines.length;
  });
  return rows;
}
