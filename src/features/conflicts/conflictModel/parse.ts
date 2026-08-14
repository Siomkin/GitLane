// Reading a conflicted file: splitting it into lines that survive a round
// trip, cutting it into context and conflict regions at git's markers, and
// the cheap facts a caller asks about the result.

import type { ConflictRegion, Region } from "./types";
const MARK_OURS = "<<<<<<<";

const MARK_BASE = "|||||||";

const MARK_SPLIT = "=======";

const MARK_THEIRS = ">>>>>>>";

/**
 * Parse conflicted file content into context + conflict regions. Handles both
 * the default 2-way markers and diff3 (with a `|||||||` base section). Lines are
 * split on `\n`; a trailing newline does not produce a phantom empty line.
 */
/** Split on `\n` without a phantom empty line from a trailing newline. */
export function splitFileLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function parseConflict(content: string): Region[] {
  const lines = splitFileLines(content);

  const regions: Region[] = [];
  let ctx: string[] = [];
  const flushCtx = () => {
    if (ctx.length > 0) {
      regions.push({ kind: "ctx", lines: ctx });
      ctx = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith(MARK_OURS)) {
      flushCtx();
      const ours: string[] = [];
      const theirs: string[] = [];
      let base: string[] | null = null;
      i++; // skip the <<<<<<< marker
      while (i < lines.length && !lines[i].startsWith(MARK_BASE) && !lines[i].startsWith(MARK_SPLIT)) {
        ours.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].startsWith(MARK_BASE)) {
        base = [];
        i++; // skip |||||||
        while (i < lines.length && !lines[i].startsWith(MARK_SPLIT)) {
          base.push(lines[i]);
          i++;
        }
      }
      // A well-formed hunk has both a `=======` split and a `>>>>>>>` close. If
      // either is missing the markers are corrupt (truncated/nested) and the
      // reconstructed text would be wrong — flag the hunk so callers refuse to
      // stage it (see `hasMalformedHunk` / `isResolved`).
      let sawSplit = false;
      let sawTheirs = false;
      if (i < lines.length && lines[i].startsWith(MARK_SPLIT)) {
        sawSplit = true;
        i++; // skip =======
      }
      while (i < lines.length && !lines[i].startsWith(MARK_THEIRS)) {
        theirs.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].startsWith(MARK_THEIRS)) {
        sawTheirs = true;
        i++; // skip >>>>>>>
      }
      regions.push({ kind: "cf", ours, theirs, base, malformed: !sawSplit || !sawTheirs });
    } else {
      ctx.push(lines[i]);
      i++;
    }
  }
  flushCtx();
  return regions;
}

/**
 * Content identity of one conflict hunk (GL-180): a stable hash of its two
 * sides. Decisions and line picks are bound to the print of the hunk they were
 * made against, so when a file changes on disk only the hunks that actually
 * changed lose their decisions — a watcher refresh with identical content
 * preserves everything. Base (diff3) lines are excluded: they are display-only
 * and never contribute to the reconstructed resolution.
 */
export function hunkFingerprint(region: ConflictRegion): string {
  const s = JSON.stringify([region.ours, region.theirs]);
  // FNV-1a — tiny, deterministic, collision-safe enough for per-file hunk
  // identity (the length suffix guards the truncation cases).
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(36)}:${s.length}`;
}

/** Number of conflict hunks in a parsed file. */
export function conflictRegionCount(regions: Region[]): number {
  return regions.filter((r) => r.kind === "cf").length;
}

/** True when any hunk had structurally incomplete markers. A file with a
 * malformed hunk can't be reconstructed safely, so the UI must keep it out of
 * the stageable set and steer the user to fix it externally. */
export function hasMalformedHunk(regions: Region[]): boolean {
  return regions.some((r) => r.kind === "cf" && r.malformed);
}

/** Whether `content` ended with a newline, so {@link buildResolved} can preserve
 * a file that had no trailing newline instead of silently appending one. */
export function endsWithNewline(content: string): boolean {
  return content.endsWith("\n");
}
