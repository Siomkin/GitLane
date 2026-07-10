// Pure view-model derivations for the conflict workspace (GL-179): operation-
// aware side labels, per-file decision/pick mapping out of the resolver's
// `path::idx` maps, effective line selections, next-selection builders for the
// line editor's mutations, per-file stage readiness, and the selected file's
// resolution flags. Framework-free — `useConflictWorkspaceModel` memoizes over
// these; the tests drive them directly.

import type { ConflictFileContent } from "../../../lib/api";
import type { ActiveOperationKind, OperationFile } from "../../../store/repo";
import {
  buildResolved,
  conflictRegionCount,
  decidedCount,
  deriveSelection,
  endsWithNewline,
  hasMalformedHunk,
  hunkFingerprint,
  isResolved,
  parseConflict,
  type ConflictRegion,
  type LineSelection,
  type Region,
  type RegionDecision,
} from "../conflictModel";

/** One side of a conflict hunk in the line editor's pick encoding. */
export type EditorSide = "a" | "b";

/**
 * Git inverts ours/theirs during a rebase: HEAD ("ours", index stage 2) is the
 * commit you're replaying *onto*, and the patch being applied ("theirs", stage
 * 3) is your own commit. The "ours"/"theirs" buttons map straight to git's
 * `--ours`/`--theirs`, so the side *labels* must be operation-aware or a user
 * mid-rebase picks the opposite of what they intend. A handoff carry (GL-74)
 * re-applies the destination's own uncommitted changes onto the handed-off
 * branch: "ours" (stage 2) is that branch, "theirs" (stage 3) is the
 * destination's prior changes being replayed.
 */
export function sideLabels(
  kind: ActiveOperationKind | null,
  headBranch: string | null,
): { oursSub: string; theirsSub: string } {
  const rebasing = kind === "rebase";
  const carrying = kind === "carry";
  return {
    oursSub: rebasing
      ? "rebased onto (ours)"
      : headBranch
        ? `${headBranch} (ours)`
        : "current (ours)",
    theirsSub: rebasing
      ? "your commit (theirs)"
      : carrying
        ? "carried changes (theirs)"
        : "incoming (theirs)",
  };
}

/** Hunk-indexed cells for one file, pulled out of a resolver `path::idx` map. */
export function fileCells<T>(
  regions: Region[],
  all: Record<string, T>,
  path: string,
): Record<number, T> {
  const out: Record<number, T> = {};
  regions.forEach((_, idx) => {
    const v = all[`${path}::${idx}`];
    if (v !== undefined) out[idx] = v;
  });
  return out;
}

/** Effective picks for one hunk: explicit line picks, else the picks implied by
 * a whole-hunk decision (so switching editor modes carries the choice over). */
export function pickSelection(
  regions: Region[],
  idx: number,
  fileDecisions: Record<number, RegionDecision>,
  fileLineSel: Record<number, LineSelection>,
): LineSelection {
  // Mirror effectiveDecision: an empty pick set is "no explicit picks", not an
  // explicit everything-dropped choice (the resolver deletes empty sets, so
  // this is defensive alignment).
  const explicit = fileLineSel[idx];
  if (explicit && explicit.size > 0) return explicit;
  const region = regions[idx];
  return region && region.kind === "cf"
    ? deriveSelection(region, fileDecisions[idx])
    : new Set<string>();
}

/** Keys for one side's lines in a hunk (the line editor's pick encoding). */
export function sideKeys(region: ConflictRegion, side: EditorSide): string[] {
  return (side === "a" ? region.ours : region.theirs).map((_, i) => `${side}:${i}`);
}

/** The selection after toggling one line. */
export function toggledLine(
  current: LineSelection,
  side: EditorSide,
  lineIdx: number,
): LineSelection {
  const next = new Set(current);
  const key = `${side}:${lineIdx}`;
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** The selection after switching one side's whole block on or off. */
export function withBlock(
  current: LineSelection,
  region: ConflictRegion,
  side: EditorSide,
  on: boolean,
): LineSelection {
  const next = new Set(current);
  sideKeys(region, side).forEach((k) => (on ? next.add(k) : next.delete(k)));
  return next;
}

/** A fresh selection taking one side (or both) of a hunk wholesale. */
export function takenBlock(region: ConflictRegion, which: "a" | "b" | "both"): LineSelection {
  const next = new Set<string>();
  if (which === "a" || which === "both") sideKeys(region, "a").forEach((k) => next.add(k));
  if (which === "b" || which === "both") sideKeys(region, "b").forEach((k) => next.add(k));
  return next;
}

/**
 * The merged text for one cached file when its local decisions fully resolve
 * it, else null: unloaded/binary content or an undecided hunk means the file is
 * not ready to stage. Zero conflict regions (markers edited away externally)
 * counts as ready — the content stages as-is.
 *
 * Every decision must carry a fingerprint matching the hunk it applies to
 * (GL-180): a decision recorded against different hunk content — the file
 * changed on disk since the user chose — counts as undecided, so a stale
 * choice can never assemble the wrong merge.
 */
export function resolvedTextFor(
  content: ConflictFileContent | undefined,
  path: string,
  decisions: Record<string, RegionDecision>,
  lineSel: Record<string, LineSelection>,
  hunkPrints: Record<string, string>,
): string | null {
  if (!content || content.binary) return null;
  const regions = parseConflict(content.content);
  const decs = fileCells(regions, decisions, path);
  const sels = fileCells(regions, lineSel, path);
  for (const idxStr of new Set([...Object.keys(decs), ...Object.keys(sels)])) {
    const idx = Number(idxStr);
    const region = regions[idx];
    const valid = region?.kind === "cf" && hunkPrints[`${path}::${idx}`] === hunkFingerprint(region);
    if (!valid) {
      delete decs[idx];
      delete sels[idx];
    }
  }
  const ready = conflictRegionCount(regions) === 0 || isResolved(regions, decs, sels);
  if (!ready) return null;
  return buildResolved(regions, decs, sels, endsWithNewline(content.content));
}

/** Stage-all eligibility: any unstaged text file is fully decided locally.
 * Gated on the file's CURRENT kind, not just the cached content — a refresh
 * can reclassify a file as binary/deleted while stale text sits in the cache,
 * and stale text must never qualify it for staging (GL-179 review). */
export function stageAllEligible(
  files: OperationFile[],
  contentFor: (path: string) => ConflictFileContent | undefined,
  decisions: Record<string, RegionDecision>,
  lineSel: Record<string, LineSelection>,
  hunkPrints: Record<string, string>,
): boolean {
  return files.some(
    (f) =>
      !f.resolved &&
      f.kind === "text" &&
      resolvedTextFor(contentFor(f.path), f.path, decisions, lineSel, hunkPrints) !== null,
  );
}

/** How one file should be staged, decided against its freshly-read disk copy. */
export type StagePlan =
  /** Write the merged text rebuilt from the (validated) in-app decisions. */
  | { action: "write"; text: string }
  /** No markers left on disk — stage the worktree copy as-is (the same path as
   * per-file "Mark resolved", so the two flows never diverge; GL-180). */
  | { action: "stageAsIs" }
  /** Not ready: reclassified/gone/binary content, or the hunks changed on disk
   * since the user decided. Nothing must be written. */
  | { action: "skip" };

/**
 * Decide the staging action for one file from its live operation entry and the
 * content just re-read from disk (GL-180). Staging paths call this *after*
 * revalidating, so the plan is always built against the disk copy — never the
 * render-time cache: a mid-run external edit, reclassification, or already-
 * completed stage yields "skip" instead of a stale write.
 */
export function stagePlanFor(
  file: OperationFile | null | undefined,
  fresh: ConflictFileContent | null,
  decisions: Record<string, RegionDecision>,
  lineSel: Record<string, LineSelection>,
  hunkPrints: Record<string, string>,
): StagePlan {
  if (!file || file.resolved || file.kind !== "text") return { action: "skip" };
  if (!fresh || fresh.binary) return { action: "skip" };
  if (conflictRegionCount(parseConflict(fresh.content)) === 0) return { action: "stageAsIs" };
  const text = resolvedTextFor(fresh, file.path, decisions, lineSel, hunkPrints);
  return text == null ? { action: "skip" } : { action: "write", text };
}

/** The selected file's resolution flags driving the editor chrome. */
export interface FileResolutionState {
  totalHunks: number;
  decided: number;
  /** Corrupt/truncated markers can't be reconstructed in-app — block staging
   * and tell the user to fix the file in their own editor. */
  malformed: boolean;
  /** A text file whose loaded content has no conflict markers left — edited
   * away externally, or emptied entirely — counts as resolved: `git add` it
   * as-is. Gated on loaded, non-binary content (not `regions.length`) so an
   * empty file (zero regions) still qualifies rather than getting stuck. */
  noMarkers: boolean;
  /** Binary conflicts (and text classified binary) resolve as-is — the user
   * picks a side, or stages an external resolution via "Mark resolved". */
  binary: boolean;
  /** Whole-file conflicts (binary, text-as-binary, or modify/delete) stage
   * their worktree copy as-is via `git add` when resolved manually. */
  wholeFile: boolean;
  staged: boolean;
  resolved: boolean;
}

export function fileResolutionState(
  selectedFile: OperationFile | null,
  content: ConflictFileContent | null,
  regions: Region[],
  fileDecisions: Record<number, RegionDecision>,
  fileLineSel: Record<number, LineSelection>,
): FileResolutionState {
  const totalHunks = conflictRegionCount(regions);
  const decided = decidedCount(regions, fileDecisions, fileLineSel);
  const malformed = hasMalformedHunk(regions);
  const textContentReady =
    !!selectedFile && selectedFile.kind === "text" && !!content && !content.binary;
  const noMarkers = textContentReady && totalHunks === 0;
  const binary =
    !!selectedFile &&
    (selectedFile.kind === "binary" || (selectedFile.kind === "text" && !!content?.binary));
  const wholeFile = binary || selectedFile?.kind === "deleted";
  const staged = !!selectedFile?.resolved;
  const resolved =
    staged || noMarkers || (totalHunks > 0 && isResolved(regions, fileDecisions, fileLineSel));
  return { totalHunks, decided, malformed, noMarkers, binary, wholeFile, staged, resolved };
}
