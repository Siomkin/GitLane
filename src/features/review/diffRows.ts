// Pure flattening of a file's hunks into a single positional row list, so the
// diff bodies can be windowed (one virtual row per header/line) instead of
// mounting every line. Kept free of React/DOM so the row math is unit-testable.

import type { DiffHunk, DiffLine } from "../../lib/api";

/** A split-view row: a deletion on the left paired with its addition on the
 * right (either side may be absent for a pure add/del). */
export type SplitRow = { left: DiffLine | null; right: DiffLine | null };

/** One flattened row of a unified diff: a hunk header or a single line. */
export type UnifiedRow =
  | { kind: "header"; header: string; key: string }
  | { kind: "line"; line: DiffLine; key: string };

/** One flattened row of a split diff: a hunk header or a left/right pair. */
export type SplitDiffRow =
  | { kind: "header"; header: string; key: string }
  | { kind: "row"; row: SplitRow; key: string };

/** Flatten hunks into header + line rows, in render order. Keys are stable for
 * a given diff so the virtualizer can track rows across re-renders. */
export function flattenUnified(hunks: DiffHunk[]): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  hunks.forEach((hunk, h) => {
    rows.push({ kind: "header", header: hunk.header, key: `h${h}` });
    hunk.lines.forEach((line, l) => rows.push({ kind: "line", line, key: `h${h}l${l}` }));
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
      rows.push({ left: lines[i], right: lines[i] });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
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
  hunks.forEach((hunk, h) => {
    rows.push({ kind: "header", header: hunk.header, key: `h${h}` });
    toSplitRows(hunk.lines).forEach((row, r) => rows.push({ kind: "row", row, key: `h${h}r${r}` }));
  });
  return rows;
}
