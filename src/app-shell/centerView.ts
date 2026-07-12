// Which workspace owns the center pane — the single encoding of the app's
// priority-ordered view machine. An active conflict operation supersedes
// everything (the repo is in a blocking state); the PR view follows the tab;
// a history inspection (compare / file history) and the stacked review are
// overlays raised on top of whichever tab is active; the changes tab splits
// into the multi-file vs single-file review; and a committed file opened from
// the inspector reviews in place of the graph. `CenterWorkspace` maps the key
// to a component and derives the error boundary's reset keys from the same
// decision, so the dispatch can't drift apart.

import type { LeftTab } from "@/lib/ui";
import type { ChangeSource } from "@/store/repoTypes";

export type CenterViewKey =
  | "conflict"
  | "pulls"
  | "inspect"
  | "stacked"
  | "file"
  | "changes"
  | "review"
  | "review-commit"
  | "history";

export interface CenterViewInput {
  /** An active merge/rebase/cherry-pick/revert (repo store `operation`). */
  inConflict: boolean;
  /** The toolbar tab (ui store `leftTab`). */
  leftTab: LeftTab;
  /** A commit-range comparison is open (repo store `compare`). */
  comparing: boolean;
  /** The file-history/blame inspector is open (repo store `fileHistory`). */
  fileHistoryOpen: boolean;
  /** A stacked all-files review is open (ui store `stackedReview`). */
  stackedReviewOpen: boolean;
  /** A repository file is open read-only from the Files tab (repo store
   * `fileView`). Ranked just below the stacked review: a stacked review opened
   * later shows on top (the file view resurfaces when it closes), while
   * `openRepoFile` closes any stacked review so a file opened later wins too. */
  fileViewOpen: boolean;
  /** Changes tab flavour: true = stacked all-files, false = single-file review. */
  changesAll: boolean;
  /** Source of the selected file, when one is selected (repo store `selectedFile`). */
  selectedFileSource: ChangeSource | null;
}

export function deriveCenterView(input: CenterViewInput): CenterViewKey {
  if (input.inConflict) return "conflict";
  if (input.leftTab === "pulls") return "pulls";
  if (input.comparing || input.fileHistoryOpen) return "inspect";
  if (input.stackedReviewOpen) return "stacked";
  if (input.fileViewOpen) return "file";
  if (input.leftTab === "changes") return input.changesAll ? "changes" : "review";
  if (input.selectedFileSource === "commit") return "review-commit";
  return "history";
}
