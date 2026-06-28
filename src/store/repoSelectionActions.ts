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
  | "refreshCompare"
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
      // Stale-response guard token: a repo switch mid-request must not let this
      // response publish into a different repo (the path/oid checks alone can
      // collide when both repos share a relative path).
      const repoPath = summary.path;
      const fresh = () => get().summary?.path === repoPath && get().fileHistory?.path === requestPath;
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
          blameError: null,
          blameRevision: null,
          blameSelectedOid: null,
        },
        error: null,
      });
      try {
        const page = await api.fileHistory(repoPath, path, 0, 100);
        if (!fresh()) return;
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
        if (!fresh()) return;
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
      const repoPath = summary.path;
      const fresh = () => get().summary?.path === repoPath && get().fileHistory?.path === requestPath;
      set((state) => ({
        fileHistory: state.fileHistory ? { ...state.fileHistory, loadingMore: true } : null,
      }));
      try {
        const page = await api.fileHistory(repoPath, requestPath, fileHistory.nextOffset, 100);
        if (!fresh()) return;
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
        if (!fresh()) return;
        set((state) => ({
          fileHistory: state.fileHistory
            ? { ...state.fileHistory, loadingMore: false, error: String(e) }
            : null,
        }));
      }
    },

    selectFileHistoryRevision: async (oid, pathOverride, full = false) => {
      const { summary, fileHistory } = get();
      if (!summary || !fileHistory) return;
      const filePath = pathOverride ?? fileHistory.path;
      const requestPath = fileHistory.path;
      const repoPath = summary.path;
      const fresh = () => {
        const current = get().fileHistory;
        return (
          get().summary?.path === repoPath &&
          current?.path === requestPath &&
          current.selectedOid === oid
        );
      };
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
        const selectedDiff = await api.commitFileDiff(repoPath, oid, filePath, full);
        if (!fresh()) return;
        set((state) => ({
          fileHistory: state.fileHistory
            ? { ...state.fileHistory, selectedDiff, diffLoading: false }
            : null,
        }));
      } catch (e) {
        if (!fresh()) return;
        set((state) => ({
          fileHistory: state.fileHistory
            ? { ...state.fileHistory, diffLoading: false, error: String(e) }
            : null,
        }));
      }
    },

    loadFileBlame: async (revision, pathOverride) => {
      const { summary, fileHistory } = get();
      if (!summary || !fileHistory) return;
      const requestPath = fileHistory.path;
      const repoPath = summary.path;
      const blameRevision = revision ?? fileHistory.selectedOid;
      // Blame the path the file had at the target revision (renames change it),
      // falling back to the current path when no historical path is known.
      const blamePath = pathOverride ?? fileHistory.selectedPath ?? fileHistory.path;
      const fresh = () => {
        const current = get().fileHistory;
        return (
          get().summary?.path === repoPath &&
          current?.path === requestPath &&
          current.blameRevision === blameRevision
        );
      };
      set((state) => ({
        fileHistory: state.fileHistory
          ? {
              ...state.fileHistory,
              blameLoading: true,
              blameError: null,
              blameRevision,
              blameSelectedOid: null,
            }
          : null,
      }));
      try {
        const blame = await api.fileBlame(repoPath, blamePath, blameRevision);
        if (!fresh()) return;
        set((state) => ({
          fileHistory: state.fileHistory
            ? { ...state.fileHistory, blame, blameLoading: false }
            : null,
        }));
      } catch (e) {
        if (!fresh()) return;
        set((state) => ({
          fileHistory: state.fileHistory
            ? { ...state.fileHistory, blameLoading: false, blameError: String(e) }
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
      const repoPath = summary.path;
      const fresh = () => {
        const cur = get().compare;
        return get().summary?.path === repoPath && cur?.base === base && cur.head === head;
      };
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
          diffError: null,
        },
        error: null,
      });
      try {
        const result = await api.compareRefs(repoPath, base, head);
        // Bail if the user opened a different comparison or switched repos.
        if (!fresh()) return;
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
        if (!fresh()) return;
        set((state) => ({
          compare: state.compare ? { ...state.compare, loading: false, error: String(e) } : null,
        }));
      }
    },

    selectCompareFile: async (path, full = false) => {
      const { summary, compare } = get();
      if (!summary || !compare) return;
      const { base, head } = compare;
      const repoPath = summary.path;
      const fresh = () => {
        const cur = get().compare;
        return (
          get().summary?.path === repoPath &&
          cur?.base === base &&
          cur.head === head &&
          cur.selectedPath === path
        );
      };
      set((state) => ({
        compare: state.compare
          ? { ...state.compare, selectedPath: path, selectedDiff: null, diffLoading: true, diffError: null }
          : null,
      }));
      try {
        const selectedDiff = await api.compareFileDiff(repoPath, base, head, path, full);
        if (!fresh()) return;
        set((state) => ({
          compare: state.compare ? { ...state.compare, selectedDiff, diffLoading: false } : null,
        }));
      } catch (e) {
        if (!fresh()) return;
        // A per-file diff failure stays in diffError so the changed-files list
        // (loaded from compare_refs) remains visible.
        set((state) => ({
          compare: state.compare
            ? { ...state.compare, diffLoading: false, diffError: String(e) }
            : null,
        }));
      }
    },

    refreshCompare: async () => {
      const { summary, compare } = get();
      if (!summary || !compare) return;
      const { base, head } = compare;
      const repoPath = summary.path;
      const fresh = () => {
        const cur = get().compare;
        return get().summary?.path === repoPath && cur?.base === base && cur.head === head;
      };
      try {
        const result = await api.compareRefs(repoPath, base, head);
        if (!fresh()) return;
        // Update the file set in place (no loading flicker, keep the selection).
        set((state) => ({
          compare: state.compare
            ? {
                ...state.compare,
                files: result.files,
                add: result.add,
                del: result.del,
                ahead: result.ahead,
                behind: result.behind,
                error: null,
              }
            : null,
        }));
        // Re-read the *current* selection — the user may have picked another file
        // while this refresh was in flight; don't yank them back to a stale path.
        const selectedPath = get().compare?.selectedPath ?? null;
        const stillThere = selectedPath && result.files.some((f) => f.path === selectedPath);
        if (stillThere) {
          // Ref-to-ref comparisons are pinned to immutable commits: if the file
          // set and totals came back byte-identical, the selected file's diff
          // can't have changed, so skip re-fetching it. Working-tree compares
          // (head === null) can change content without moving line counts, so
          // they always re-fetch to stay truthful.
          const unchanged =
            head !== null &&
            result.add === compare.add &&
            result.del === compare.del &&
            result.ahead === compare.ahead &&
            result.behind === compare.behind &&
            result.files.length === compare.files.length &&
            result.files.every((f, i) => {
              const prev = compare.files[i];
              return (
                !!prev &&
                prev.path === f.path &&
                prev.status === f.status &&
                prev.add === f.add &&
                prev.del === f.del
              );
            });
          if (!(unchanged && get().compare?.selectedDiff)) {
            // Re-fetch the selected file's diff so it reflects the new endpoint state.
            void get().selectCompareFile(selectedPath);
          }
        } else if (!selectedPath) {
          // Nothing selected (or selection cleared): land on the first file if any.
          const first = result.files[0]?.path ?? null;
          if (first) void get().selectCompareFile(first);
        } else {
          // The selected file is gone from the new result set: fall back / clear.
          const next = result.files[0]?.path ?? null;
          if (next) {
            void get().selectCompareFile(next);
          } else {
            set((state) => ({
              compare: state.compare
                ? { ...state.compare, selectedPath: null, selectedDiff: null, diffLoading: false }
                : null,
            }));
          }
        }
      } catch {
        // A best-effort background refresh: leave the prior view in place on error.
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
