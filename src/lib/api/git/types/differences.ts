// Per-difference inclusion for the commit review workspace — mirrors
// `src-tauri/src/git/types/differences.rs`.

import type { DiffLine, FileDiff } from "./diff";

/** A contiguous run of lines inside one hunk of the staged or unstaged diff,
 * starting at `lineStart` and guarded by the lines the UI displayed. */
export interface DiffLineRange {
  hunkIndex: number;
  lineStart: number;
  expected: DiffLine[];
}

/** `apply_line_range` / `revert_line_range`: one atomic patch over several
 * ranges of one file; `staged` picks the staged diff (unstage). */
export interface ApplyLineRangeRequest {
  file: string;
  staged: boolean;
  ranges: DiffLineRange[];
}

/** How much of one HEAD-to-working-tree difference the index already holds. */
export type Inclusion = "included" | "excluded" | "partial";

/** One block of changed lines in {@link FileDifferences.diff}. `stage` ranges
 * include it (and are what a revert restores when it is excluded); `unstage`
 * ranges exclude it. */
export interface Difference {
  hunkIndex: number;
  lineStart: number;
  lineEnd: number;
  inclusion: Inclusion;
  stage: DiffLineRange[];
  unstage: DiffLineRange[];
}

/** One file's HEAD-to-working-tree diff split into differences. `differences`
 * is empty when the file can only be included as a whole. */
export interface FileDifferences {
  diff: FileDiff;
  differences: Difference[];
  /** True when `diff` shows the whole file as one hunk; false for 3-line-context
   * hunks, including a whole-file request for a file too long to show whole. */
  wholeFile: boolean;
}
