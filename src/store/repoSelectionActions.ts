import { api } from "../lib/api";
import { computeSelection } from "./selection";
import { useUi } from "./ui";
import type { RepoGet, RepoSet, RepoState } from "./repoTypes";

export function createRepoSelectionActions(
  set: RepoSet,
  get: RepoGet,
): Pick<
  RepoState,
  | "selectCommit"
  | "revealCommit"
  | "revealStash"
  | "consumeReveal"
  | "selectCommitMulti"
  | "clearSelection"
  | "selectWip"
  | "selectFile"
  | "loadFullFileDiff"
  | "clearSelectedFile"
  | "compareRange"
> {
  return {
    selectCommit: async (id) => get().selectCommitMulti(id ?? "", {}),

    revealCommit: async (id) => {
      // Picking a branch should land you on the graph at its tip: drop any open
      // stacked review, flag the scroll target, then select it (loads its files).
      useUi.getState().closeStackedReview();
      set({ revealTarget: id });
      await get().selectCommit(id);
    },

    revealStash: (oid) => {
      useUi.getState().closeStackedReview();
      set({ revealTarget: oid });
    },

    consumeReveal: () => set((s) => (s.revealTarget === null ? s : { revealTarget: null })),

    selectCommitMulti: async (id, mods, orderedIds) => {
      const { summary, graph } = get();
      // Shift-range order excludes interleaved stash nodes — a range spanning a
      // stash must not pull its oid into the commit multi-selection.
      const ids = orderedIds ?? graph?.commits.filter((c) => !c.stash).map((c) => c.id) ?? [];
      const { selected: selectedCommits, anchor, focus } = computeSelection(
        { ids, selected: get().selectedCommits, anchor: get().selectionAnchor },
        id,
        mods,
      );

      set({
        selectedCommit: focus,
        selectedCommits,
        selectionAnchor: anchor,
        wipSelected: false,
        selectedFile: null,
        fileDiff: null,
        commitFiles: [],
        error: null,
      });
      if (!summary || !focus) return;
      set({ diffLoading: true });
      try {
        const files = await api.commitFiles(summary.path, focus);
        set({ commitFiles: files, diffLoading: false });
      } catch (e) {
        set({ diffLoading: false, error: String(e) });
      }
    },

    clearSelection: () => set({ selectedCommits: [], selectionAnchor: null }),

    // Select the WIP node — like selecting a commit, but it inspects the working
    // changes in the right panel instead of opening the changes/review view.
    selectWip: () =>
      set({
        wipSelected: true,
        selectedCommit: null,
        selectedCommits: [],
        selectionAnchor: null,
        selectedFile: null,
        fileDiff: null,
        commitFiles: [],
      }),

    selectFile: async (path, source) => {
      const { summary, selectedCommit } = get();
      if (!summary) return;
      set({ selectedFile: { path, source }, diffLoading: true, error: null });
      try {
        const fileDiff =
          source === "commit" && selectedCommit
            ? await api.commitFileDiff(summary.path, selectedCommit, path)
            : await api.fileDiff(summary.path, path, source === "staged");
        set({ fileDiff, diffLoading: false });
      } catch (e) {
        set({ diffLoading: false, error: String(e) });
      }
    },

    loadFullFileDiff: async () => {
      const { summary, selectedFile, selectedCommit } = get();
      if (!summary || !selectedFile) return;
      const { path, source } = selectedFile;
      set({ diffLoading: true });
      try {
        const fileDiff =
          source === "commit" && selectedCommit
            ? await api.commitFileDiff(summary.path, selectedCommit, path, true)
            : await api.fileDiff(summary.path, path, source === "staged", true);
        // Guard against a selection change while the larger diff was building.
        if (get().selectedFile?.path !== path) return;
        set({ fileDiff, diffLoading: false });
      } catch (e) {
        set({ diffLoading: false, error: String(e) });
      }
    },

    clearSelectedFile: () => set({ selectedFile: null, fileDiff: null, diffLoading: false }),

    compareRange: (base, head, title) => {
      useUi.getState().openRangeReview(base, head, title);
    },
  };
}
