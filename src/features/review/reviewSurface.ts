import type { ChangeSource } from "../../store/repoTypes";

/**
 * The notes "surface" key for the single-file review pane's open file. A
 * committed file viewed as part of a **multi-commit selection** scopes to the
 * whole selection (`selection:<oids>`), matching `StackedReview`'s key for the
 * same pick — so a comment on the merged per-file diff doesn't collide with, or
 * leak into, a single-commit review of the focus commit. A single committed file
 * scopes to its commit; a working file to its staged/unstaged source.
 */
export function reviewSurface(
  selectedFile: { source: ChangeSource } | null,
  selectedCommit: string | null,
  selectionCommits: string[] | null,
): string {
  if (selectedFile?.source === "commit") {
    return selectionCommits && selectionCommits.length > 0
      ? `selection:${selectionCommits.join(",")}`
      : `commit:${selectedCommit ?? ""}`;
  }
  return `work:${selectedFile?.source ?? "unstaged"}`;
}
