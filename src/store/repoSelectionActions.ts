import { api } from "@/lib/api";
import { invalidateFileDiffReconciles } from "./repoFileDiff";
import { repoSessionIsCurrent } from "./repoGuards";
import { publishedRepoSession } from "./repoRequests";
import { loadSelectionUnion } from "./repoSelectionDiff";
import { buildCommitBatchPlan, computeSelection, workingRange, WIP_SELECTION_ID } from "./selection";
import { useUi } from "./ui";
import type { RepoGet, RepoSet, RepoState } from "./repoTypes";

/** Order-independent identity of a multi-commit selection. The union is
 * order-independent (the backend re-sorts by ancestry) and `refresh` can
 * re-publish the same set reordered, so a stale-response guard must compare the
 * *set* — an order-sensitive key would make a slow per-file fetch bail and leave
 * the diff pane stuck on `loading`. */
const selectionKey = (diff?: { commits: string[]; workingBase?: string | null } | null): string | null =>
  diff ? `${diff.workingBase ?? ""}|${[...diff.commits].sort().join(",")}` : null;

export function createRepoSelectionActions(
  set: RepoSet,
  get: RepoGet,
): Pick<
  RepoState,
  | "selectCommit"
  | "revealCommit"
  | "revealStash"
  | "returnToGraph"
  | "consumeReveal"
  | "selectCommitMulti"
  | "clearSelection"
  | "selectWip"
  | "ensureWorkingFileSelection"
  | "selectFile"
  | "loadFullFileDiff"
  | "clearSelectedFile"
  | "compareRange"
  | "openFileHistory"
  | "setFileHistoryMode"
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
  // File-history routes have three independent response lanes. Visible
  // path/revision values are not sufficient ownership keys: same-path retries,
  // preview -> full for one oid, and A -> B -> A can all make an old request's
  // subject visible again. Latest-start generations plus the published repo
  // session make those ABA cycles unambiguous.
  let fileHistoryListGeneration = 0;
  let fileHistoryDiffGeneration = 0;
  let fileHistoryBlameGeneration = 0;
  const claimFileHistoryList = () => ++fileHistoryListGeneration;
  const claimFileHistoryDiff = () => ++fileHistoryDiffGeneration;
  const claimFileHistoryBlame = () => ++fileHistoryBlameGeneration;
  const invalidateFileHistory = () => {
    fileHistoryListGeneration += 1;
    fileHistoryDiffGeneration += 1;
    fileHistoryBlameGeneration += 1;
  };

  // Compare endpoints are not a sufficient response owner: two background
  // refreshes can target the same base/head, and two full-diff requests can
  // target the same selected path. Keep independent latest-start generations
  // for the file-list/totals read and the selected-file diff read.
  let compareListGeneration = 0;
  let compareDiffGeneration = 0;
  const claimCompareList = () => ++compareListGeneration;
  const claimCompareDiff = () => ++compareDiffGeneration;
  const invalidateCompare = () => {
    compareListGeneration += 1;
    compareDiffGeneration += 1;
  };

  return {
    selectCommit: async (id) => get().selectCommitMulti(id ?? "", {}),

    revealCommit: async (id) => {
      // Picking a branch should land you on the graph at its tip: leave every
      // higher-priority route (we may be on the PRs page or inside a
      // comparison/file-history/stacked/commit-file review — HistoryWorkspace
      // must mount to scroll to the target and clear the request via
      // consumeReveal), flag the scroll target, then select it (loads its files).
      get().returnToGraph();
      set({ revealTarget: id });
      await get().selectCommit(id);
    },

    revealStash: (oid) => {
      get().returnToGraph();
      set({ revealTarget: oid });
    },

    returnToGraph: () => {
      // Order-free: each close is an independent slice; deriveCenterView falls
      // through to "history" once none of them outranks the tab. A *working*
      // file selection is kept — it doesn't outrank the graph (the inspector
      // shows it); only a committed file's review takes over the center pane.
      invalidateFileHistory();
      set((s) => ({
        fileSelectionRequestId: s.fileSelectionRequestId + 1,
        diffLoading: false,
        compare: null,
        fileHistory: null,
        fileView: null,
        ...(s.selectedFile?.source === "commit"
          ? { selectedFile: null, fileDiff: null, diffLoading: false }
          : {}),
      }));
      useUi.getState().closeStackedReview();
      useUi.getState().setLeftTab("history");
    },

    consumeReveal: () => set((s) => (s.revealTarget === null ? s : { revealTarget: null })),

    selectCommitMulti: async (id, mods, orderedIds) => {
      const { summary, graph, changes } = get();
      // Shift-range order excludes interleaved stash nodes — a range spanning a
      // stash must not pull its oid into the commit multi-selection. The WIP row
      // sits above the newest commit while the tree is dirty, so it joins the
      // range order there and can be picked along with commits.
      const commitIds = orderedIds ?? graph?.commits.filter((c) => !c.stash).map((c) => c.id) ?? [];
      const dirty =
        changes.staged.length + changes.unstaged.length + changes.conflicted.length > 0;
      const ids = dirty ? [WIP_SELECTION_ID, ...commitIds] : commitIds;
      const previous = get().wipSelected
        ? [WIP_SELECTION_ID, ...get().selectedCommits]
        : get().selectedCommits;
      // Selecting the WIP row alone clears the anchor (it isn't an oid), so a
      // shift-extension *from* WIP would otherwise start over at the clicked
      // commit. Anchor on the sentinel for this call only; it is never stored.
      const priorAnchor =
        get().selectionAnchor ?? (get().wipSelected && dirty ? WIP_SELECTION_ID : null);
      const { selected, anchor, focus } = computeSelection(
        { ids, selected: previous, anchor: priorAnchor },
        id,
        mods,
      );

      // Strip the WIP sentinel back out: `selectedCommits` stays real oids only,
      // so batch ops (cherry-pick/revert/squash) and the backend never see it.
      const wip = selected.includes(WIP_SELECTION_ID);
      const selectedCommits = selected.filter((x) => x !== WIP_SELECTION_ID);
      if (wip && selectedCommits.length === 0) {
        get().selectWip();
        return;
      }
      // Commits + uncommitted is one range ending at the working tree
      // (`workingRange`): it spans from the oldest pick's parent to the tree, so
      // unpicked commits between the endpoints are included and the inspector
      // says so. It needs the newest pick to be HEAD; a root commit or an older
      // run with newer commits above it can't express the range, so the WIP row
      // is left out and the pick stays a plain committed union.
      const plan = buildCommitBatchPlan(graph, selectedCommits);
      const workingBase = wip ? workingRange(graph, selectedCommits)?.base ?? null : null;
      const wipSelected = wip && workingBase !== null;
      // The pick can't reach the working tree (off HEAD's first-parent line, or
      // a root commit): leave the existing selection exactly as it is instead of
      // re-fetching the same union and flashing its spinner.
      if (wip && !wipSelected && selectedCommits.length === get().selectedCommits.length &&
          selectedCommits.every((oid) => get().selectedCommits.includes(oid))) {
        return;
      }
      // Clicking the WIP row focuses it; the commit-level focus (right panel,
      // Restore, single-commit file list) falls back to the newest real commit
      // in graph order — `selectedCommits` is click order for an additive pick.
      const focusCommit =
        focus === WIP_SELECTION_ID ? plan.ordered[0] ?? selectedCommits[0] ?? null : focus;

      // More than one commit selected → the inspector shows a merged ("union")
      // diff across the whole selection (GL-68/GL-69): the net change per file,
      // for any selection (contiguous or not — the backend composes it). One
      // commit plus the WIP row is merged too — that's the point of including it.
      const multi = selectedCommits.length > 1 || wipSelected;
      const fileSelectionRequestId = get().fileSelectionRequestId + 1;

      set({
        fileSelectionRequestId,
        diffLoading: false,
        selectedCommit: focusCommit,
        selectedCommits,
        selectionAnchor: anchor,
        wipSelected,
        fileHistory: null,
        compare: null,
        fileView: null,
        selectedFile: null,
        fileDiff: null,
        commitFiles: [],
        selectionDiff: multi
          ? { commits: selectedCommits, files: [], workingBase, loading: true, error: null }
          : null,
        error: null,
      });
      if (!summary) return;

      if (multi) {
        // Fetch the union behind a stale-response guard (shared with `refresh`).
        await loadSelectionUnion(set, get, summary.path, selectedCommits, workingBase);
        return;
      }

      if (!focusCommit) return;
      const repoPath = summary.path;
      const repoSession = publishedRepoSession.current();
      // Don't let a single-commit fetch publish into a newer selection or a
      // different repo (a slow reject after a repo switch must not flash a stale
      // error onto the new repo's view).
      const fresh = () =>
        repoSessionIsCurrent(get, repoPath, repoSession) &&
        get().fileSelectionRequestId === fileSelectionRequestId &&
        !get().selectionDiff &&
        get().selectedCommit === focusCommit;
      set({ diffLoading: true });
      try {
        const files = await api.commitFiles(repoPath, focusCommit);
        if (!fresh()) return;
        set({ commitFiles: files, diffLoading: false });
      } catch (e) {
        if (!fresh()) return;
        set({ diffLoading: false, error: String(e) });
      }
    },

    clearSelection: () =>
      set({ selectedCommits: [], selectionAnchor: null, selectionDiff: null, wipSelected: false }),

    // Select the WIP node — like selecting a commit, but it inspects the working
    // changes in the right panel instead of opening the changes/review view.
    selectWip: () =>
      set((state) => ({
        fileSelectionRequestId: state.fileSelectionRequestId + 1,
        diffLoading: false,
        wipSelected: true,
        fileHistory: null,
        compare: null,
        fileView: null,
        selectedCommit: null,
        selectedCommits: [],
        selectionAnchor: null,
        selectionDiff: null,
        selectedFile: null,
        fileDiff: null,
        commitFiles: [],
      })),

    ensureWorkingFileSelection: () => {
      const { changes, selectedFile } = get();
      const workingSelection = selectedFile?.source === "commit" ? null : selectedFile;
      if (workingSelection) {
        const currentBucket =
          workingSelection.source === "unstaged" ? changes.unstaged : changes.staged;
        if (currentBucket.some((file) => file.path === workingSelection.path)) return;

        // Staging/unstaging can move the selected path between buckets. Keep the
        // path but update its source so the next diff reads the correct index.
        const otherSource = workingSelection.source === "unstaged" ? "staged" : "unstaged";
        const otherBucket = otherSource === "unstaged" ? changes.unstaged : changes.staged;
        if (otherBucket.some((file) => file.path === workingSelection.path)) {
          void get().selectFile(workingSelection.path, otherSource);
          return;
        }
      }

      const first = changes.unstaged[0] ?? changes.staged[0];
      if (first) {
        void get().selectFile(first.path, changes.unstaged[0] ? "unstaged" : "staged");
      } else if (workingSelection) {
        get().clearSelectedFile();
      }
    },

    selectFile: async (path, source) => {
      const { summary, selectedCommit, selectionDiff } = get();
      if (!summary) return;
      const repoPath = summary.path;
      // Selection identity at request time. A selection change nulls
      // `selectedFile`, but switching between two multi-selections that share a
      // file path keeps the path — so also pin the union's commit set, or a slow
      // response could publish the wrong selection's merged diff for that file.
      const selKey = selectionKey(selectionDiff);
      const requestId = get().fileSelectionRequestId + 1;
      const fresh = () =>
        get().summary?.path === repoPath &&
        get().selectedFile?.path === path &&
        get().selectedFile?.source === source &&
        get().fileSelectionRequestId === requestId &&
        selectionKey(get().selectionDiff) === selKey;
      // An explicit selection supersedes any background reconcile in flight —
      // its result must not publish over this fresher fetch (GL-123).
      invalidateFileDiffReconciles();
      // Selecting a file dismisses the standalone repo-file viewer — the diff of
      // the chosen file takes over the center pane.
      set({
        selectedFile: { path, source },
        fileSelectionRequestId: requestId,
        fileView: null,
        diffLoading: true,
        error: null,
      });
      try {
        // In a multi-commit selection a committed file's diff is the merged
        // ("union") diff across the whole selection, not the focus commit (GL-69).
        const fileDiff =
          source === "commit" && selectionDiff?.workingBase
            ? await api.compareFileDiff(repoPath, selectionDiff.workingBase, null, path)
            : source === "commit" && selectionDiff
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
      const selKey = selectionKey(selectionDiff);
      const requestId = get().fileSelectionRequestId + 1;
      const fresh = () =>
        get().summary?.path === repoPath &&
        get().selectedFile?.path === path &&
        get().selectedFile?.source === source &&
        get().fileSelectionRequestId === requestId &&
        selectionKey(get().selectionDiff) === selKey;
      // See selectFile: drop any in-flight reconcile so it can't overwrite the
      // expanded diff after this load completes.
      invalidateFileDiffReconciles();
      set({ diffLoading: true, fileSelectionRequestId: requestId });
      try {
        const fileDiff =
          source === "commit" && selectionDiff?.workingBase
            ? await api.compareFileDiff(repoPath, selectionDiff.workingBase, null, path, true)
            : source === "commit" && selectionDiff
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

    clearSelectedFile: () =>
      set((state) => ({
        fileSelectionRequestId: state.fileSelectionRequestId + 1,
        selectedFile: null,
        fileDiff: null,
        diffLoading: false,
      })),

    compareRange: (base, head, title) => {
      useUi.getState().openRangeReview(base, head, title);
    },

    openFileHistory: async (path, mode = "history") => {
      const { summary } = get();
      if (!summary) return;
      const requestPath = path;
      const repoPath = summary.path;
      const session = publishedRepoSession.current();
      const generation = claimFileHistoryList();
      // A new history route invalidates every child request from the prior
      // route, even when it opens the same relative path again.
      fileHistoryDiffGeneration += 1;
      fileHistoryBlameGeneration += 1;
      const fresh = () =>
        generation === fileHistoryListGeneration &&
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
      const generation = claimFileHistoryList();
      const fresh = () =>
        generation === fileHistoryListGeneration &&
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
      const generation = claimFileHistoryDiff();
      const fresh = () => {
        const current = get().fileHistory;
        return (
          generation === fileHistoryDiffGeneration &&
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
      const generation = claimFileHistoryBlame();
      const blameRevision = revision ?? fileHistory.selectedOid;
      // Blame the path the file had at the target revision (renames change it),
      // falling back to the current path when no historical path is known.
      const blamePath = pathOverride ?? fileHistory.selectedPath ?? fileHistory.path;
      const fresh = () => {
        const current = get().fileHistory;
        return (
          generation === fileHistoryBlameGeneration &&
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
      invalidateFileHistory();
      set((state) => ({
        fileSelectionRequestId: state.fileSelectionRequestId + 1,
        diffLoading: false,
        fileHistory: null,
      }));
    },

    openCompare: async ({ base, head, baseLabel, headLabel, scope, title }) => {
      const { summary } = get();
      if (!summary) return;
      const repoPath = summary.path;
      const generation = claimCompareList();
      invalidateFileHistory();
      // A new comparison invalidates any selected-file diff from the previous
      // route, including an A -> B -> A endpoint cycle.
      compareDiffGeneration += 1;
      const fresh = () => {
        const cur = get().compare;
        return (
          generation === compareListGeneration &&
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
      const generation = claimCompareDiff();
      const fresh = () => {
        const cur = get().compare;
        return (
          generation === compareDiffGeneration &&
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
      const generation = claimCompareList();
      // The refreshed file list defines the selected diff's snapshot too. Stop
      // an older diff from landing while this newer list read is still pending.
      compareDiffGeneration += 1;
      // The invalidated diff can no longer clear its own spinner. Keep the last
      // good diff visible while the list refresh runs; a winning list result
      // starts a fresh selected-file request (and spinner) below.
      set((state) => ({
        compare: state.compare ? { ...state.compare, diffLoading: false } : null,
      }));
      const fresh = () => {
        const cur = get().compare;
        return (
          generation === compareListGeneration &&
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
      invalidateCompare();
      set((state) => ({
        fileSelectionRequestId: state.fileSelectionRequestId + 1,
        diffLoading: false,
        compare: null,
      }));
    },
  };
}
