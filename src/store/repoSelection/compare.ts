// The compare route: an arbitrary base..head comparison with its own file list,
// totals, path filter, and selected-file diff. Opening one closes file history
// (they share the review pane), so it drives that registry too.

import { api } from "@/lib/api";
import type {
  CompareGenerations,
  FileHistoryGenerations,
} from "@/store/repoSelection/generations";
import type { RepoGet, RepoSet, RepoState } from "@/store/repoTypes";

export function createCompareActions(
  set: RepoSet,
  get: RepoGet,
  fileHistoryGen: FileHistoryGenerations,
  compareGen: CompareGenerations,
): Pick<
  RepoState,
  | "openCompare"
  | "selectCompareFile"
  | "refreshCompare"
  | "setComparePathFilter"
  | "swapCompare"
  | "closeCompare"
> {
  return {
    openCompare: async ({ base, head, baseLabel, headLabel, scope, title }) => {
      const { summary } = get();
      if (!summary) return;
      const repoPath = summary.path;
      const generation = compareGen.claimList();
      fileHistoryGen.invalidate();
      // A new comparison invalidates any selected-file diff from the previous
      // route, including an A -> B -> A endpoint cycle.
      compareGen.invalidateDiff();
      const fresh = () => {
        const cur = get().compare;
        return (
          generation === compareGen.listGeneration() &&
          get().summary?.path === repoPath &&
          cur?.base === base &&
          cur.head === head
        );
      };
      set({
        fileSelectionRequestId: get().fileSelectionRequestId + 1,
        diffLoading: false,
        fileHistory: null,
        fileView: null,
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
        if (first && fresh()) void get().selectCompareFile(first.path);
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
      const generation = compareGen.claimDiff();
      const fresh = () => {
        const cur = get().compare;
        return (
          generation === compareGen.diffGeneration() &&
          get().summary?.path === repoPath &&
          cur?.base === base &&
          cur.head === head &&
          cur.selectedPath === path
        );
      };
      set((state) => ({
        fileSelectionRequestId: state.fileSelectionRequestId + 1,
        diffLoading: false,
        compare: state.compare
          ? {
              ...state.compare,
              selectedPath: path,
              selectedDiff:
                state.compare.selectedPath === path ? state.compare.selectedDiff : null,
              diffLoading: true,
              diffError: null,
            }
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
      const generation = compareGen.claimList();
      // The refreshed file list defines the selected diff's snapshot too. Stop
      // an older diff from landing while this newer list read is still pending.
      compareGen.invalidateDiff();
      // The invalidated diff can no longer clear its own spinner. Keep the last
      // good diff visible while the list refresh runs; a winning list result
      // starts a fresh selected-file request (and spinner) below.
      set((state) => ({
        compare: state.compare ? { ...state.compare, diffLoading: false } : null,
      }));
      const fresh = () => {
        const cur = get().compare;
        return (
          generation === compareGen.listGeneration() &&
          get().summary?.path === repoPath &&
          cur?.base === base &&
          cur.head === head
        );
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
          // Endpoints may be moving branch/ref names, not immutable object ids;
          // equal file stats do not prove equal content. Every winning refresh
          // therefore re-fetches the selected diff.
          if (fresh()) void get().selectCompareFile(selectedPath);
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

    closeCompare: () => {
      compareGen.invalidate();
      set((state) => ({
        fileSelectionRequestId: state.fileSelectionRequestId + 1,
        diffLoading: false,
        compare: null,
      }));
    },
  };
}
