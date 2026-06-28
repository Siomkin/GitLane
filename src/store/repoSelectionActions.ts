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
  | "openFileHistory"
  | "loadMoreFileHistory"
  | "selectFileHistoryRevision"
  | "loadFileBlame"
  | "selectBlameLine"
  | "closeFileHistory"
  | "openCompare"
  | "selectCompareFile"
  | "setComparePathFilter"
  | "swapCompare"
  | "closeCompare"
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
        fileHistory: null,
        compare: null,
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
        fileHistory: null,
        compare: null,
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

    openFileHistory: async (path, mode = "history") => {
      const { summary } = get();
      if (!summary) return;
      const requestPath = path;
      set({
        compare: null,
        fileHistory: {
          path,
          mode,
          entries: [],
          loading: true,
          loadingMore: false,
          error: null,
          hasMore: false,
          nextOffset: 0,
          truncated: false,
          selectedOid: null,
          selectedPath: null,
          selectedDiff: null,
          diffLoading: false,
          blame: null,
          blameLoading: mode === "blame",
          blameRevision: null,
          blameSelectedOid: null,
        },
        error: null,
      });
      try {
        const page = await api.fileHistory(summary.path, path, 0, 100);
        if (get().fileHistory?.path !== requestPath) return;
        set((state) => ({
          fileHistory: state.fileHistory
            ? {
                ...state.fileHistory,
                entries: page.entries,
                loading: false,
                hasMore: page.hasMore,
                nextOffset: page.nextOffset,
                truncated: page.truncated,
              }
            : null,
        }));
        const first = page.entries[0];
        if (first) void get().selectFileHistoryRevision(first.oid, first.path);
        if (mode === "blame") void get().loadFileBlame(first?.oid ?? null);
      } catch (e) {
        if (get().fileHistory?.path !== requestPath) return;
        set((state) => ({
          fileHistory: state.fileHistory
            ? { ...state.fileHistory, loading: false, blameLoading: false, error: String(e) }
            : null,
        }));
      }
    },

    loadMoreFileHistory: async () => {
      const { summary, fileHistory } = get();
      if (!summary || !fileHistory || fileHistory.loadingMore || !fileHistory.hasMore) return;
      const requestPath = fileHistory.path;
      set((state) => ({
        fileHistory: state.fileHistory ? { ...state.fileHistory, loadingMore: true } : null,
      }));
      try {
        const page = await api.fileHistory(summary.path, requestPath, fileHistory.nextOffset, 100);
        if (get().fileHistory?.path !== requestPath) return;
        set((state) => ({
          fileHistory: state.fileHistory
            ? {
                ...state.fileHistory,
                entries: [...state.fileHistory.entries, ...page.entries],
                loadingMore: false,
                hasMore: page.hasMore,
                nextOffset: page.nextOffset,
                truncated: page.truncated,
              }
            : null,
        }));
      } catch (e) {
        if (get().fileHistory?.path !== requestPath) return;
        set((state) => ({
          fileHistory: state.fileHistory
            ? { ...state.fileHistory, loadingMore: false, error: String(e) }
            : null,
        }));
      }
    },

    selectFileHistoryRevision: async (oid, pathOverride) => {
      const { summary, fileHistory } = get();
      if (!summary || !fileHistory) return;
      const filePath = pathOverride ?? fileHistory.path;
      const requestPath = fileHistory.path;
      set((state) => ({
        fileHistory: state.fileHistory
          ? {
              ...state.fileHistory,
              selectedOid: oid,
              selectedPath: filePath,
              selectedDiff: null,
              diffLoading: true,
              error: null,
            }
          : null,
      }));
      try {
        const selectedDiff = await api.commitFileDiff(summary.path, oid, filePath);
        const current = get().fileHistory;
        if (current?.path !== requestPath || current.selectedOid !== oid) return;
        set((state) => ({
          fileHistory: state.fileHistory
            ? { ...state.fileHistory, selectedDiff, diffLoading: false }
            : null,
        }));
      } catch (e) {
        const current = get().fileHistory;
        if (current?.path !== requestPath || current.selectedOid !== oid) return;
        set((state) => ({
          fileHistory: state.fileHistory
            ? { ...state.fileHistory, diffLoading: false, error: String(e) }
            : null,
        }));
      }
    },

    loadFileBlame: async (revision) => {
      const { summary, fileHistory } = get();
      if (!summary || !fileHistory) return;
      const requestPath = fileHistory.path;
      const blameRevision = revision ?? fileHistory.selectedOid;
      set((state) => ({
        fileHistory: state.fileHistory
          ? { ...state.fileHistory, blameLoading: true, blameRevision, blameSelectedOid: null }
          : null,
      }));
      try {
        const blame = await api.fileBlame(summary.path, requestPath, blameRevision);
        const current = get().fileHistory;
        if (current?.path !== requestPath || current.blameRevision !== blameRevision) return;
        set((state) => ({
          fileHistory: state.fileHistory
            ? { ...state.fileHistory, blame, blameLoading: false }
            : null,
        }));
      } catch (e) {
        const current = get().fileHistory;
        if (current?.path !== requestPath || current.blameRevision !== blameRevision) return;
        set((state) => ({
          fileHistory: state.fileHistory
            ? { ...state.fileHistory, blameLoading: false, error: String(e) }
            : null,
        }));
      }
    },

    selectBlameLine: (oid) =>
      set((state) => ({
        fileHistory: state.fileHistory
          ? { ...state.fileHistory, blameSelectedOid: oid }
          : null,
      })),

    closeFileHistory: () => set({ fileHistory: null }),

    openCompare: async ({ base, head, baseLabel, headLabel, scope, title }) => {
      const { summary } = get();
      if (!summary) return;
      set({
        fileHistory: null,
        compare: {
          base,
          head,
          baseLabel,
          headLabel,
          scope,
          title,
          files: [],
          loading: true,
          error: null,
          add: 0,
          del: 0,
          ahead: 0,
          behind: 0,
          pathFilter: "",
          selectedPath: null,
          selectedDiff: null,
          diffLoading: false,
        },
        error: null,
      });
      try {
        const result = await api.compareRefs(summary.path, base, head);
        // Bail if the user opened a different comparison meanwhile.
        const cur = get().compare;
        if (cur?.base !== base || cur.head !== head) return;
        set((state) => ({
          compare: state.compare
            ? {
                ...state.compare,
                files: result.files,
                add: result.add,
                del: result.del,
                ahead: result.ahead,
                behind: result.behind,
                loading: false,
              }
            : null,
        }));
        const first = result.files[0];
        if (first) void get().selectCompareFile(first.path);
      } catch (e) {
        const cur = get().compare;
        if (cur?.base !== base || cur.head !== head) return;
        set((state) => ({
          compare: state.compare ? { ...state.compare, loading: false, error: String(e) } : null,
        }));
      }
    },

    selectCompareFile: async (path) => {
      const { summary, compare } = get();
      if (!summary || !compare) return;
      const { base, head } = compare;
      set((state) => ({
        compare: state.compare
          ? { ...state.compare, selectedPath: path, selectedDiff: null, diffLoading: true }
          : null,
      }));
      try {
        const selectedDiff = await api.compareFileDiff(summary.path, base, head, path);
        const cur = get().compare;
        if (cur?.base !== base || cur.head !== head || cur.selectedPath !== path) return;
        set((state) => ({
          compare: state.compare ? { ...state.compare, selectedDiff, diffLoading: false } : null,
        }));
      } catch (e) {
        const cur = get().compare;
        if (cur?.base !== base || cur.head !== head || cur.selectedPath !== path) return;
        set((state) => ({
          compare: state.compare
            ? { ...state.compare, diffLoading: false, error: String(e) }
            : null,
        }));
      }
    },

    setComparePathFilter: (filter) =>
      set((state) => (state.compare ? { compare: { ...state.compare, pathFilter: filter } } : {})),

    swapCompare: async () => {
      const { compare } = get();
      // Only commit-range comparisons have two commits to swap; a working-tree
      // comparison has no second endpoint.
      if (!compare || compare.head === null) return;
      await get().openCompare({
        base: compare.head,
        head: compare.base,
        baseLabel: compare.headLabel,
        headLabel: compare.baseLabel,
        scope: compare.scope,
        title: `Comparing ${compare.baseLabel} with ${compare.headLabel}`,
      });
    },

    closeCompare: () => set({ compare: null }),
  };
}
