import type { DiffHunk, DiffLine, FileDiff } from "@/lib/api";

/** Stage/unstage callbacks for the open file's diff. Null for committed diffs,
 * which can't be staged. Built by the review container; both diff views consume it. */
export type HunkActionApi = {
  source: "unstaged" | "staged";
  onApply: (hunkIndex: number, expectedHeader: string, expectedBody: string) => void;
  onApplyLine: (hunkIndex: number, lineIndex: number, line: DiffLine) => void;
};

/** The one whole-file-only rule for hunk staging. A rename/copy patch cannot be
 * split: staging one hunk of it would stage the new path alone and strand the
 * old path's deletion, so it stages as a file — with the reason shown, like an
 * untracked file. (Committed diffs never get a `HunkActionApi` at all.) */
export const hunkPatchUnavailableReason = (file: FileDiff): string | null => {
  if (file.truncated) return "Load the full diff before staging hunks";
  if (file.binary) return "Binary diffs cannot be staged by hunk";
  if (file.hunks.length === 0) return "No text hunks are available";
  if (file.status === "U") return "Untracked files can only be staged as a file";
  if (file.status === "R") return "Renamed files can only be staged as a file";
  if (file.status === "C") return "Copied files can only be staged as a file";
  if (file.status === "T") return "Type changes can only be staged as a file";
  return null;
};

/** Line-level staging is unavailable wherever hunk staging is, plus on whole-file
 * add/delete diffs: their patches carry `new file`/`deleted file` headers + a
 * /dev/null side, which `git apply` rejects for a single-line (partial) patch.
 * Such files stage/unstage as a whole instead. */
export const lineStagePatchUnavailableReason = (file: FileDiff): string | null => {
  const hunkReason = hunkPatchUnavailableReason(file);
  if (hunkReason) return hunkReason;
  if (file.status === "A" || file.status === "D") {
    return "Added/deleted files can only be staged as a file";
  }
  return null;
};

/** The per-view staging derivation both diff views share (GL-162 review):
 * hunk/line availability for the open file plus whether the buttons stage or
 * unstage. Null `hunkAction` (committed diff) yields all-null/stage — the
 * views already gate every button on `hunkAction` itself. */
export function hunkStaging(
  file: FileDiff,
  hunkAction: HunkActionApi | null,
): {
  unavailableReason: string | null;
  lineUnavailable: string | null;
  mode: "stage" | "unstage";
} {
  return {
    unavailableReason: hunkAction ? hunkPatchUnavailableReason(file) : null,
    lineUnavailable: hunkAction ? lineStagePatchUnavailableReason(file) : null,
    mode: hunkAction?.source === "staged" ? "unstage" : "stage",
  };
}

/** Canonical body of a hunk, one `{sign}{content}` line per row joined by
 * newlines — the form the staging backend reconstructs from its patch source.
 * Passed to `applyHunk` so the backend can reject staging a hunk whose content
 * changed on disk since it was displayed (the @@ range alone isn't enough). */
export const hunkBody = (hunk: DiffHunk): string =>
  hunk.lines
    .map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.content}`)
    .join("\n");
