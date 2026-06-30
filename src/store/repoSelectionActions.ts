import { api } from "../lib/api";
import { loadSelectionUnion } from "./repoSelectionDiff";
import { computeSelection } from "./selection";
import { useUi } from "./ui";
import type { RepoGet, RepoSet, RepoState } from "./repoTypes";

/** Order-independent identity of a multi-commit selection. The union is
 * order-independent (the backend re-sorts by ancestry) and `refresh` can
 * re-publish the same set reordered, so a stale-response guard must compare the
 * *set* — an order-sensitive key would make a slow per-file fetch bail and leave
 * the diff pane stuck on `loading`. */
const selectionKey = (commits?: string[] | null): string | null =>
  commits ? [...commits].sort().join(",") : null;

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

      // More than one commit selected → the inspector shows a merged ("union")
      // diff across the whole selection (GL-68/GL-69): the net change per file,
      // for any selection (contiguous or not — the backend composes it).
      const multi = selectedCommits.length > 1;

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
        selectionDiff: multi
          ? { commits: selectedCommits, files: [], loading: true, error: null }
          : null,
        error: null,
      });
      if (!summary) return;

      if (multi) {
        // Fetch the union behind a stale-response guard (shared with `refresh`).
        await loadSelectionUnion(set, get, summary.path, selectedCommits);
        return;
      }

      if (!focus) return;
      const repoPath = summary.path;
      // Don't let a single-commit fetch publish into a newer selection or a
      // different repo (a slow reject after a repo switch must not flash a stale
      // error onto the new repo's view).
      const fresh = () =>
        get().summary?.path === repoPath && !get().selectionDiff && get().selectedCommit === focus;
      set({ diffLoading: true });
      try {
        const files = await api.commitFiles(repoPath, focus);
        if (!fresh()) return;
        set({ commitFiles: files, diffLoading: false });
      } catch (e) {
        if (!fresh()) return;
        set({ diffLoading: false, error: String(e) });
      }
    },

    clearSelection: () => set({ selectedCommits: [], selectionAnchor: null, selectionDiff: null }),

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
        selectionDiff: null,
        selectedFile: null,
        fileDiff: null,
        commitFiles: [],
      }),

    selectFile: async (path, source) => {
      const { summary, selectedCommit, selectionDiff } = get();
      if (!summary) return;
      const repoPath = summary.path;
      // Selection identity at request time. A selection change nulls
      // `selectedFile`, but switching between two multi-selections that share a
      // file path keeps the path — so also pin the union's commit set, or a slow
      // response could publish the wrong selection's merged diff for that file.
      const selKey = selectionKey(selectionDiff?.commits);
      const fresh = () =>
        get().summary?.path === repoPath &&
        get().selectedFile?.path === path &&
        selectionKey(get().selectionDiff?.commits) === selKey;
      set({ selectedFile: { path, source }, diffLoading: true, error: null });
      try {
        // In a multi-commit selection a committed file's diff is the merged
        // ("union") diff across the whole selection, not the focus commit (GL-69).
        const fileDiff =
          source === "commit" && selectionDiff
            ? await api.selectionDiffFile(repoPath, selectionDiff.commits, path)
            : source === "commit" && selectedCommit
              ? await api.commitFileDiff(repoPath, selectedCommit, path)
              : await api.fileDiff(repoPath, path, source === "staged");
        if (!fresh()) return;
        set({ fileDiff, diffLoading: false });
      } catch (e) {
        if (!fresh()) return;
        set({ diffLoading: false, error: String(e) });
      }
    },

    loadFullFileDiff: async () => {
      const { summary, selectedFile, selectedCommit, selectionDiff } = get();
      if (!summary || !selectedFile) return;
      const { path, source } = selectedFile;
      const repoPath = summary.path;
      const selKey = selectionKey(selectionDiff?.commits);
      const fresh = () =>
        get().summary?.path === repoPath &&
        get().selectedFile?.path === path &&
        selectionKey(get().selectionDiff?.commits) === selKey;
      set({ diffLoading: true });
      try {
        const fileDiff =
          source === "commit" && selectionDiff
            ? await api.selectionDiffFile(repoPath, selectionDiff.commits, path, true)
            : source === "commit" && selectedCommit
              ? await api.commitFileDiff(repoPath, selectedCommit, path, true)
              : await api.fileDiff(repoPath, path, source === "staged", true);
        // Guard against a selection/file change while the larger diff was building.
        if (!fresh()) return;
        set({ fileDiff, diffLoading: false });
      } catch (e) {
        if (!fresh()) return;
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
