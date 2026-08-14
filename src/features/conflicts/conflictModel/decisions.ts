// Turning decisions into output: which side (or which lines) a region
// resolves to, whether the file is fully decided, and the resolved text and
// rows that follow.

import type {
  ConflictRegion,
  LineSelection,
  Region,
  RegionDecision,
  ResolvedRow,
} from "./types";
import { conflictRegionCount, endsWithNewline, hasMalformedHunk } from "./parse";
/**
 * The effective decision for a hunk, reconciling the two inputs: a non-empty
 * line selection (from the line editor) always means "lines"; otherwise the
 * whole-hunk decision (from inline mode) stands. This is what lets a hunk be
 * resolved either way and keeps the two editors consistent.
 */
export function effectiveDecision(
  decision: RegionDecision | undefined,
  selection: LineSelection | undefined,
): RegionDecision | undefined {
  if (selection && selection.size > 0) return "lines";
  return decision;
}

/** Seed a line selection from a whole-hunk decision, so switching a hunk that
 * was accepted ours/theirs/both into the line editor starts pre-ticked. */
export function deriveSelection(
  region: ConflictRegion,
  decision: RegionDecision | undefined,
): LineSelection {
  const sel = new Set<string>();
  if (decision === "ours" || decision === "both") region.ours.forEach((_, i) => sel.add(`a:${i}`));
  if (decision === "theirs" || decision === "both") region.theirs.forEach((_, i) => sel.add(`b:${i}`));
  return sel;
}

/** How many conflict hunks have an effective decision recorded. */
export function decidedCount(
  regions: Region[],
  decisions: Record<number, RegionDecision | undefined>,
  lineSel: Record<number, LineSelection> = {},
): number {
  let n = 0;
  regions.forEach((r, idx) => {
    if (r.kind === "cf" && effectiveDecision(decisions[idx], lineSel[idx])) n += 1;
  });
  return n;
}

/** True when every conflict hunk has been decided (file ready to stage). */
export function isResolved(
  regions: Region[],
  decisions: Record<number, RegionDecision | undefined>,
  lineSel: Record<number, LineSelection> = {},
): boolean {
  return (
    conflictRegionCount(regions) > 0 &&
    !hasMalformedHunk(regions) &&
    decidedCount(regions, decisions, lineSel) === conflictRegionCount(regions)
  );
}

/**
 * Reconstruct the merged file text from the user's per-hunk choices. Context
 * regions pass through unchanged; conflict hunks emit the chosen side(s).
 * Undecided hunks are dropped, so callers should only build text once
 * {@link isResolved} is true.
 *
 * `trailingNewline` should reflect whether the *original* conflicted file ended
 * with a newline (see {@link endsWithNewline}); pass `false` to avoid adding one
 * to a file that didn't have it, which would otherwise be a spurious content
 * change beyond the resolution. Defaults to `true` (the common case).
 */
export function buildResolved(
  regions: Region[],
  decisions: Record<number, RegionDecision | undefined>,
  lineSel: Record<number, LineSelection>,
  trailingNewline = true,
  custom: Record<number, string[]> = {},
): string {
  const out: string[] = [];
  regions.forEach((region, idx) => {
    if (region.kind === "ctx") {
      out.push(...region.lines);
      return;
    }
    // One decision cascade for the whole model: the text is the rows without
    // their side provenance, so the two can never drift apart.
    const rows = resolvedRows(
      region,
      effectiveDecision(decisions[idx], lineSel[idx]),
      lineSel[idx] ?? new Set<string>(),
      custom[idx] ?? [],
    );
    out.push(...rows.map((r) => r.line));
  });
  // A resolution that contributes no lines (e.g. accepting an empty side for a
  // whole-file conflict) is a genuinely empty file — return "" rather than the
  // lone "\n" that `join("\n") + "\n"` would produce, which would corrupt an
  // intended empty resolution.
  if (out.length === 0) return "";
  const text = out.join("\n");
  return trailingNewline ? text + "\n" : text;
}

/** The lines a decided hunk contributes, with their side, for rendering the
 * resolved result (mirrors {@link buildResolved} but keeps side provenance). */
export function resolvedRows(
  region: ConflictRegion,
  decision: RegionDecision | undefined,
  selection: LineSelection,
  custom: string[] = [],
): ResolvedRow[] {
  if (decision === "custom") return custom.map((line) => ({ line, side: "ai" }));
  if (decision === "ours") return region.ours.map((line) => ({ line, side: "a" }));
  if (decision === "theirs") return region.theirs.map((line) => ({ line, side: "b" }));
  if (decision === "both")
    return [
      ...region.ours.map((line) => ({ line, side: "a" as const })),
      ...region.theirs.map((line) => ({ line, side: "b" as const })),
    ];
  if (decision === "lines") {
    const rows: ResolvedRow[] = [];
    region.ours.forEach((line, i) => {
      if (selection.has(`a:${i}`)) rows.push({ line, side: "a" });
    });
    region.theirs.forEach((line, i) => {
      if (selection.has(`b:${i}`)) rows.push({ line, side: "b" });
    });
    return rows;
  }
  return [];
}
