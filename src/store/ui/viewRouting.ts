// Where the workspace is pointed: the center tab, the right inspector tab, and
// the stacked review that outranks both.

import type { LeftTab, RightTab } from "@/lib/ui";
import type { ComposerSlice } from "./composer";
import type { MenuSlice } from "./menus";
import type { SliceSet } from "./slice";

/** The stacked review's fetch mode, arm-named like `CommitDiffRoute`
 * (store/selection.ts): one commit (or stash commit), a base..head combined
 * range, or the merged ("union") diff across a multi-commit selection (GL-69). */
export type StackedReviewRoute =
  | { kind: "commit"; oid: string; title: string }
  | { kind: "range"; base: string; head: string; title: string }
  | { kind: "selection"; commits: string[]; title: string };

export interface ViewRoutingSlice {
  /** Which center view the toolbar tabs select: the history graph, the changes
   * (staging/review) view, or the PR list + detail. Transient — every repo
   * starts on history (see `onRepoSwitched`), so it never persists. */
  leftTab: LeftTab;

  /** Which tab the right inspector panel shows: the contextual details
   * (commit/working inspector) or the repository Files browser. Transient like
   * `leftTab` — every repo starts on details. */
  rightTab: RightTab;

  /** Changes view: false = single-file review (default), true = stacked all-files. */
  changesAll: boolean;

  /** When set, the center pane shows a stacked all-files review for this pick.
   * A discriminated union like `CommitDiffRoute` (store/selection.ts): every
   * consumer switches on `kind`, so the notes surface, the file-list fetch, and
   * the per-file diff fetch cannot disagree about which diff is showing. */
  stackedReview: StackedReviewRoute | null;

  setLeftTab: (tab: LeftTab) => void;
  setRightTab: (tab: RightTab) => void;
  /** Open the changes view from the working-tree inspector: `all` picks the
   * stacked multi-file review; otherwise the single-file diff (used when
   * focusing one file from the right-panel list). */
  openChangesView: (all?: boolean) => void;
  /** Reveal the inline commit composer in the Working Changes inspector. */
  openCommit: () => void;
  /** The working tree went clean (commit landed, last change discarded) — the
   * changes view has nothing left to stage or diff, so fall back to the graph
   * instead of stranding an empty "Select a file to view its diff" pane. Called
   * by the repo store wherever it publishes an empty working-changes set. */
  onWorkingTreeClean: () => void;
  openStackedReview: (oid: string, title: string) => void;
  /** Open the stacked review for a commit range (base..head combined diff). */
  openRangeReview: (base: string, head: string, title: string) => void;
  /** Open the stacked review for the merged diff across a multi-commit selection. */
  openSelectionReview: (commits: string[], title: string) => void;
  closeStackedReview: () => void;
}

/** Where the workspace is pointed. A stacked review outranks the history tab in
 * `deriveCenterView`, so a leftover one would render the previous repo's oid
 * against the new repo. */
export const resetViewRouting = () =>
  ({
    leftTab: "history",
    rightTab: "details",
    changesAll: false,
    stackedReview: null,
  }) satisfies Partial<ViewRoutingSlice>;

export function createViewRoutingSlice(
  set: SliceSet<ViewRoutingSlice & Pick<MenuSlice, "menu"> & Pick<ComposerSlice, "commitMsg">>,
): ViewRoutingSlice {
  return {
    ...resetViewRouting(),

    setLeftTab: (tab) => set((s) => (s.leftTab === tab ? s : { leftTab: tab })),
    setRightTab: (tab) => set((s) => (s.rightTab === tab ? s : { rightTab: tab })),
    openChangesView: (all = false) => set({ leftTab: "changes", changesAll: all }),
    openCommit: () => set({ leftTab: "changes", changesAll: false, rightTab: "details" }),
    onWorkingTreeClean: () =>
      set((s) =>
        s.leftTab === "changes" ? { leftTab: "history", commitMsg: "" } : { commitMsg: "" },
      ),
    openStackedReview: (oid, title) =>
      set({ menu: null, stackedReview: { kind: "commit", oid, title } }),
    openRangeReview: (base, head, title) =>
      set({ menu: null, stackedReview: { kind: "range", base, head, title } }),
    openSelectionReview: (commits, title) =>
      set({ menu: null, stackedReview: { kind: "selection", commits, title } }),
    closeStackedReview: () => set({ stackedReview: null }),
  };
}
