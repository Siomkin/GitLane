// The file-history route: one path's revisions, the diff of the revision the
// user lands on, and blame. Three independent response lanes, each owned by a
// generation from the shared registry (see `generations.ts`).

import { api } from "@/lib/api";
import { repoSessionIsCurrent } from "@/store/repoGuards";
import { publishedRepoSession } from "@/store/repoRequests";
import type { FileHistoryGenerations } from "@/store/repoSelection/generations";
import type { RepoGet, RepoSet, RepoState } from "@/store/repoTypes";

export function createFileHistoryActions(
  set: RepoSet,
  get: RepoGet,
  fileHistoryGen: FileHistoryGenerations,
): Pick<
  RepoState,
  | "openFileHistory"
  | "setFileHistoryMode"
  | "loadMoreFileHistory"
  | "selectFileHistoryRevision"
  | "loadFileBlame"
  | "selectBlameLine"
  | "closeFileHistory"
> {
  return {
    openFileHistory: async (path, mode = "history") => {
      const { summary } = get();
      if (!summary) return;
      const requestPath = path;
      const repoPath = summary.path;
      const session = publishedRepoSession.current();
      const generation = fileHistoryGen.claimList();
      // A new history route invalidates every child request from the prior
      // route, even when it opens the same relative path again.
      fileHistoryGen.invalidateDiff();
      fileHistoryGen.invalidateBlame();
      const fresh = () =>
        generation === fileHistoryGen.listGeneration() &&
        repoSessionIsCurrent(get, repoPath, session) &&
        get().fileHistory?.path === requestPath;
      set({
        fileSelectionRequestId: get().fileSelectionRequestId + 1,
        diffLoading: false,
        compare: null,
        fileView: null,
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
          diffError: null,
          blame: null,
          blameLoading: mode === "blame",
          blameError: null,
          blameRevision: null,
          blamePath: null,
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
        if (first && fresh()) void get().selectFileHistoryRevision(first.oid, first.path);
        // Consult the live mode, not the mode captured before the history read.
        // A user may switch modes while this initial page is in flight.
        if (fresh() && get().fileHistory?.mode === "blame") {
          void get().loadFileBlame(first?.oid ?? null, first?.path ?? requestPath);
        }
      } catch (e) {
        if (!fresh()) return;
        set((state) => ({
          fileHistory: state.fileHistory
            ? { ...state.fileHistory, loading: false, blameLoading: false, error: String(e) }
            : null,
        }));
      }
    },

    setFileHistoryMode: (mode, revision, pathOverride) => {
      const current = get().fileHistory;
      if (!current) return;
      if (mode === "history") {
        set((state) =>
          state.fileHistory
            ? {
                fileHistory: {
                  ...state.fileHistory,
                  mode,
                  // Direct-to-blame opens paint a placeholder spinner while
                  // the history page resolves. It owns no blame request yet.
                  ...(state.fileHistory.loading && state.fileHistory.blameRevision === null
                    ? { blameLoading: false }
                    : {}),
                },
              }
            : {},
        );
        return;
      }

      const blameRevision = revision === undefined ? current.selectedOid : revision;
      const blamePath = pathOverride ?? current.selectedPath ?? current.path;
      const targetChanged =
        current.blameRevision !== blameRevision || current.blamePath !== blamePath;
      set((state) =>
        state.fileHistory
          ? {
              fileHistory: {
                ...state.fileHistory,
                mode,
                ...(state.fileHistory.loading ? { blameLoading: true } : {}),
              },
            }
          : {},
      );
      // The initial list chooses the first revision and starts blame once it
      // lands. Until then there is no stable revision to request here.
      if (current.loading) return;
      if (targetChanged || (!current.blameLoading && current.blameRevision === null)) {
        void get().loadFileBlame(blameRevision, blamePath);
      }
    },

    loadMoreFileHistory: async () => {
      const { summary, fileHistory } = get();
      if (!summary || !fileHistory || fileHistory.loadingMore || !fileHistory.hasMore) return;
      const requestPath = fileHistory.path;
      const repoPath = summary.path;
      const session = publishedRepoSession.current();
      const generation = fileHistoryGen.claimList();
      const fresh = () =>
        generation === fileHistoryGen.listGeneration() &&
        repoSessionIsCurrent(get, repoPath, session) &&
        get().fileHistory?.path === requestPath;
      set((state) => ({
        fileHistory: state.fileHistory
          ? { ...state.fileHistory, loadingMore: true, error: null }
          : null,
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
      const session = publishedRepoSession.current();
      const generation = fileHistoryGen.claimDiff();
      const fresh = () => {
        const current = get().fileHistory;
        return (
          generation === fileHistoryGen.diffGeneration() &&
          repoSessionIsCurrent(get, repoPath, session) &&
          current?.path === requestPath &&
          current.selectedOid === oid
        );
      };
      set((state) => ({
        fileSelectionRequestId: state.fileSelectionRequestId + 1,
        diffLoading: false,
        fileHistory: state.fileHistory
          ? {
              ...state.fileHistory,
              selectedOid: oid,
              selectedPath: filePath,
              selectedDiff: null,
              diffLoading: true,
              diffError: null,
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
            ? { ...state.fileHistory, diffLoading: false, diffError: String(e) }
            : null,
        }));
      }
    },

    loadFileBlame: async (revision, pathOverride) => {
      const { summary, fileHistory } = get();
      if (!summary || !fileHistory) return;
      const requestPath = fileHistory.path;
      const repoPath = summary.path;
      const session = publishedRepoSession.current();
      const generation = fileHistoryGen.claimBlame();
      const blameRevision = revision ?? fileHistory.selectedOid;
      // Blame the path the file had at the target revision (renames change it),
      // falling back to the current path when no historical path is known.
      const blamePath = pathOverride ?? fileHistory.selectedPath ?? fileHistory.path;
      const fresh = () => {
        const current = get().fileHistory;
        return (
          generation === fileHistoryGen.blameGeneration() &&
          repoSessionIsCurrent(get, repoPath, session) &&
          current?.path === requestPath &&
          current.blameRevision === blameRevision &&
          current.blamePath === blamePath
        );
      };
      set((state) => ({
        fileHistory: state.fileHistory
          ? {
              ...state.fileHistory,
              blameLoading: true,
              blameError: null,
              blameRevision,
              blamePath,
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
        fileSelectionRequestId: state.fileSelectionRequestId + 1,
        diffLoading: false,
        fileHistory: state.fileHistory
          ? { ...state.fileHistory, blameSelectedOid: oid }
          : null,
      })),

    closeFileHistory: () => {
      fileHistoryGen.invalidate();
      set((state) => ({
        fileSelectionRequestId: state.fileSelectionRequestId + 1,
        diffLoading: false,
        fileHistory: null,
      }));
    },

  };
}
