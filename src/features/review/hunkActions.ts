import type { FileDiff } from "../../lib/api";
import type { ChangeSource } from "../../store/repo";

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
