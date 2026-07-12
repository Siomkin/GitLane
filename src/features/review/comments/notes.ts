// Pure helpers for the in-diff "local comment" system: addressing a contiguous
// range of visible diff lines, labelling that range, and composing the agent
// hand-off message. Kept free of React/DOM so the range math is unit-testable.

import type { DiffHunk, DiffLine } from "@/lib/api";
import type { ReviewNote } from "@/store/ui";

/** A visible diff line, addressable for comments. `seq` is its 0-based position
 * across the file's flattened (header-free) line list — matching diffRows' `seq`. */
export interface LineMeta {
  seq: number;
  /** "L" for deletions (old side); "R" for adds/context (new side). */
  side: "L" | "R";
  /** Line number on that side. */
  lineNo: number;
  /** Display ref, e.g. "R20" / "L4". */
  ref: string;
  /** The line's source text. */
  code: string;
}

/** A deletion belongs to the old (L) side; adds/context to the new (R) side —
 * mirroring how the diff body assigns a single number per rendered line. */
export function lineMetaFor(line: DiffLine, seq: number): LineMeta {
  const side: "L" | "R" = line.kind === "del" ? "L" : "R";
  const lineNo = (side === "L" ? line.oldNo : line.newNo) ?? 0;
  return { seq, side, lineNo, ref: `${side}${lineNo}`, code: line.content };
}

/** Flatten a file's hunks into the ordered list of addressable lines. A line's
 * seq equals its index here, matching diffRows' per-line `seq`. */
export function buildLineMeta(hunks: DiffHunk[]): LineMeta[] {
  const out: LineMeta[] = [];
  for (const hunk of hunks) for (const line of hunk.lines) out.push(lineMetaFor(line, out.length));
  return out;
}

/** Like buildLineMeta, but ordered by *split rows* so the split view can address
 * comments by row (seq = split-row index, matching diffRows' flattenSplit). Each
 * row is represented by its new-side (R) line when present, else the old-side
 * (L) deletion — so a comment anchors to the row's primary line. */
/** ref → seq, for resolving a saved note's stored refs back to positions in the
 * current diff (the diff can re-flow across refreshes; refs stay stable). */
export function refIndex(lines: LineMeta[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.ref, l.seq);
  return m;
}

/** En-dash range label, e.g. "R20" (single) or "R18–R20" (range). */
export function rangeLabel(fromRef: string, toRef: string): string {
  return fromRef === toRef ? fromRef : `${fromRef}–${toRef}`;
}

/** Header text for the editor/card, e.g. "Comment on line R20" / "…lines R18 to R20". */
export function scopeText(fromRef: string, toRef: string): string {
  return fromRef === toRef
    ? `Comment on line ${fromRef}`
    : `Comment on lines ${fromRef} to ${toRef}`;
}

/** Build a note (sans id) from a selected seq range and body. Endpoints are
 * normalised so a top-down or bottom-up drag yields the same range. */
export function buildNote(
  surface: string,
  file: string,
  lines: LineMeta[],
  fromSeq: number,
  toSeq: number,
  body: string,
): Omit<ReviewNote, "id"> {
  const a = Math.min(fromSeq, toSeq);
  const b = Math.max(fromSeq, toSeq);
  const from = lines[a];
  const to = lines[b];
  const code = lines
    .slice(a, b + 1)
    .map((l) => l.code)
    .join("\n");
  return {
    surface,
    file,
    side: to.side,
    line: to.lineNo,
    fromRef: from.ref,
    toRef: to.ref,
    lineRef: rangeLabel(from.ref, to.ref),
    code,
    body: body.trim(),
  };
}

/** Notes ordered for a stable, readable message: by file, then anchor line, then side. */
export function orderedNotes(notes: ReviewNote[]): ReviewNote[] {
  return [...notes].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.side.localeCompare(b.side),
  );
}

/** Build the default agent hand-off message from the pinned local comments. */
export function composeAgentMessage(notes: ReviewNote[], _branch?: string | null): string {
  if (notes.length === 0) return "";
  const blocks = orderedNotes(notes).map((n, i) => {
    const at = n.fromRef === n.toRef ? `line ${n.fromRef}` : `lines ${n.fromRef}–${n.toRef}`;
    return `${i + 1}. ${n.file} — ${at}\n   Feedback: ${n.body.trim()}`;
  });
  return `${blocks.join("\n\n")}\n`;
}
