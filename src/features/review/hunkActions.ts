import type { DiffHunk, DiffLine, FileDiff } from "../../lib/api";
import type { ChangeSource } from "../../store/repo";

/** Stage/unstage callbacks for the open file's diff. Null for committed diffs,
 * which can't be staged. Built by the review container; both diff views consume it. */
export type HunkActionApi = {
  source: "unstaged" | "staged";
  onApply: (hunkIndex: number, expectedHeader: string, expectedBody: string) => void;
  onApplyLine: (hunkIndex: number, lineIndex: number, line: DiffLine) => void;
};

export const hunkPatchUnavailableReason = (file: FileDiff, source: ChangeSource): string | null => {
  if (source === "commit") return "Committed diffs cannot be staged by hunk";
  if (file.truncated) return "Load the full diff before staging hunks";
  if (file.binary) return "Binary diffs cannot be staged by hunk";
  if (file.hunks.length === 0) return "No text hunks are available";
  if (file.status === "U") return "Untracked files can only be staged as a file";
  if (file.status === "R") return "Renamed files can only be staged as a file";
  if (file.status === "T") return "Type changes can only be staged as a file";
  return null;
};

/** Line-level staging is unavailable wherever hunk staging is, plus on whole-file
 * add/delete diffs: their patches carry `new file`/`deleted file` headers + a
 * /dev/null side, which `git apply --unidiff-zero` rejects for a single-line
 * (partial) patch. Such files stage/unstage as a whole instead. */
export const lineStagePatchUnavailableReason = (file: FileDiff, source: ChangeSource): string | null => {
  const hunkReason = hunkPatchUnavailableReason(file, source);
  if (hunkReason) return hunkReason;
  if (file.status === "A" || file.status === "D") {
    return "Added/deleted files can only be staged as a file";
  }
  return null;
};

/** Canonical body of a hunk, one `{sign}{content}` line per row joined by
 * newlines — the form the staging backend reconstructs from its patch source.
 * Passed to `applyHunk` so the backend can reject staging a hunk whose content
 * changed on disk since it was displayed (the @@ range alone isn't enough). */
export const hunkBody = (hunk: DiffHunk): string =>
  hunk.lines
    .map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.content}`)
    .join("\n");
