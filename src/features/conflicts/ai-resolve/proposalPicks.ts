// Split a whole-file agent proposal back into per-hunk resolutions so they
// can land in the Output pane as ticks (a side the agent took) or custom
// hunk text (a rewrite or a drop).
//
// Alignment leans on GitLane already knowing where the conflicts are: the
// context between two hunks is identical in both texts, so whatever the proposal
// has *between* two context blocks is that hunk's resolution. It is exact and
// fails closed — an agent that reformatted untouched context (or dropped a
// section) breaks the alignment, and a wrong alignment would attribute the wrong
// lines to a hunk, which is worse than showing none.
//
// Applying splits by verdict: a hunk the agent resolved to one side (or both)
// becomes ticks; a rewrite or a drop has no tick representation and becomes the
// hunk's custom resolution text instead.

import {
  deriveSelection,
  parseConflict,
  splitFileLines,
  type ConflictRegion,
  type LineSelection,
} from "@/features/conflicts/conflictModel";

export interface HunkProposal {
  /** Region index in the parsed file — the key decisions/picks are stored under. */
  idx: number;
  ours: string[];
  theirs: string[];
  /** What the agent put where this hunk was. */
  ai: string[];
  /** How the agent's lines relate to the two sides — the one-word summary. */
  verdict: "ours" | "theirs" | "both" | "rewrote" | "dropped";
}

const sameLines = (a: string[], b: string[]) =>
  a.length === b.length && a.every((line, i) => line === b[i]);

function verdictFor(region: ConflictRegion, ai: string[]): HunkProposal["verdict"] {
  if (ai.length === 0) return "dropped";
  if (sameLines(ai, region.ours)) return "ours";
  if (sameLines(ai, region.theirs)) return "theirs";
  if (sameLines(ai, [...region.ours, ...region.theirs])) return "both";
  return "rewrote";
}

/** Index of `block` in `lines` at or after `from`, or -1. */
function findBlock(lines: string[], block: string[], from: number): number {
  if (block.length === 0) return from;
  for (let i = from; i + block.length <= lines.length; i++) {
    if (block.every((line, j) => lines[i + j] === line)) return i;
  }
  return -1;
}

/** Per-hunk view of a whole-file proposal, or null when it cannot be aligned to
 * the conflicted file (reformatted context, malformed markers, content added
 * outside a conflict, or two hunks with no context between them to split apart). */
export function alignProposal(conflicted: string, proposal: string): HunkProposal[] | null {
  const regions = parseConflict(conflicted);
  if (regions.some((r) => r.kind === "cf" && r.malformed)) return null;
  const lines = splitFileLines(proposal);

  const out: HunkProposal[] = [];
  let cursor = 0;
  let pending: { region: ConflictRegion; idx: number; start: number } | null = null;

  const close = (at: number) => {
    if (!pending) return;
    const ai = lines.slice(pending.start, at);
    out.push({
      idx: pending.idx,
      ours: pending.region.ours,
      theirs: pending.region.theirs,
      ai,
      verdict: verdictFor(pending.region, ai),
    });
    pending = null;
  };

  for (const [idx, region] of regions.entries()) {
    if (region.kind === "cf") {
      // Two conflicts in a row with nothing between them cannot be split apart.
      if (pending) return null;
      pending = { region, idx, start: cursor };
      continue;
    }
    const at = findBlock(lines, region.lines, cursor);
    if (at < 0) return null;
    // Content the agent added outside any conflict — not attributable to a hunk.
    if (!pending && at !== cursor) return null;
    close(at);
    cursor = at + region.lines.length;
  }

  if (pending) close(lines.length);
  else if (cursor !== lines.length) return null;
  return out;
}

/** The ticks that express one aligned hunk, or null when the agent's lines are
 * not a side (a rewrite or a drop) — those resolve as custom text instead. */
export function picksForHunk(hunk: HunkProposal): LineSelection | null {
  if (hunk.verdict === "rewrote" || hunk.verdict === "dropped") return null;
  return deriveSelection(
    { kind: "cf", ours: hunk.ours, theirs: hunk.theirs, base: [], malformed: false },
    hunk.verdict,
  );
}
