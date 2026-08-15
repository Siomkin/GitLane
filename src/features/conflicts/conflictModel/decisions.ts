// Turning decisions into output: which side (or which lines) a region
// resolves to, whether the file is fully decided, and the resolved text and
// rows that follow.

import type {
  ConflictRegion,
  HunkChoice,
  LineSelection,
  Region,
  RegionDecision,
  ResolvedRow,
} from "./types";
import { conflictRegionCount, endsWithNewline, hasMalformedHunk } from "./parse";
/**
 * The decision a hunk's choice boils down to for counting and rendering. A
 * cell holds exactly one {@link HunkChoice}, so this is a plain switch — the
 * old reader-side reconciliation (a non-empty line selection beating a
 * whole-hunk decision) has no precedence left to encode.
 */
export function effectiveDecision(choice: HunkChoice | undefined): RegionDecision | undefined {
  switch (choice?.kind) {
    case "whole":
      return choice.decision;
    case "lines":
      return "lines";
    case "custom":
      return "custom";
    default:
      return undefined;
  }
}

/** The lines a "custom" choice keeps, else undefined. */
export function customLinesOf(choice: HunkChoice | undefined): string[] | undefined {
  return choice?.kind === "custom" ? choice.lines : undefined;
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

/** How many conflict hunks have a choice recorded. */
export function decidedCount(
  regions: Region[],
  choices: Record<number, HunkChoice> = {},
): number {
  let n = 0;
  regions.forEach((r, idx) => {
    if (r.kind === "cf" && effectiveDecision(choices[idx])) n += 1;
  });
  return n;
}

/** True when every conflict hunk has been decided (file ready to stage). */
export function isResolved(
  regions: Region[],
  choices: Record<number, HunkChoice> = {},
): boolean {
  return (
    conflictRegionCount(regions) > 0 &&
    !hasMalformedHunk(regions) &&
    decidedCount(regions, choices) === conflictRegionCount(regions)
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
  choices: Record<number, HunkChoice>,
  trailingNewline = true,
): string {
  const out: string[] = [];
  regions.forEach((region, idx) => {
    if (region.kind === "ctx") {
      out.push(...region.lines);
      return;
    }
    // One choice for the whole model: the text is the rows without their side
    // provenance, so the two can never drift apart.
    const rows = resolvedRows(region, choices[idx]);
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
  choice: HunkChoice | undefined,
): ResolvedRow[] {
  switch (choice?.kind) {
    case "custom":
      return choice.lines.map((line) => ({ line, side: "ai" }));
    case "whole":
      if (choice.decision === "ours") return region.ours.map((line) => ({ line, side: "a" }));
      if (choice.decision === "theirs") return region.theirs.map((line) => ({ line, side: "b" }));
      return [
        ...region.ours.map((line) => ({ line, side: "a" as const })),
        ...region.theirs.map((line) => ({ line, side: "b" as const })),
      ];
    case "lines": {
      const rows: ResolvedRow[] = [];
      region.ours.forEach((line, i) => {
        if (choice.selection.has(`a:${i}`)) rows.push({ line, side: "a" });
      });
      region.theirs.forEach((line, i) => {
        if (choice.selection.has(`b:${i}`)) rows.push({ line, side: "b" });
      });
      return rows;
    }
    default:
      return [];
  }
}
