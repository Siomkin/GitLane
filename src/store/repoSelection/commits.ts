// Selecting what the workspace shows: a commit (or a multi-commit range), the
// working tree, and the file inside that selection whose diff the review pane
// renders. The reveal/return-to-graph navigation lives here too, since it is
// the same selection being pointed at from elsewhere.

import { api } from "@/lib/api";
import { invalidateFileDiffReconciles } from "@/store/repoFileDiff";
import { repoSessionIsCurrent } from "@/store/repoGuards";
import { publishedRepoSession } from "@/store/repoRequests";
import type { FileHistoryGenerations } from "@/store/repoSelection/generations";
import { loadSelectionUnion } from "@/store/repoSelectionDiff";
import {
  buildCommitBatchPlan,
  COMMIT_DIFF_ROUTE,
  commitDiffRoute,
  computeSelection,
  workingRange,
  WIP_SELECTION_ID,
  type CommitDiffRoute,
} from "@/store/selection";
import type { RepoGet, RepoSet, RepoState } from "@/store/repoTypes";
import { useUi } from "@/store/ui";

/** Order-independent identity of a multi-commit selection. The union is
 * order-independent (the backend re-sorts by ancestry) and `refresh` can
 * re-publish the same set reordered, so a stale-response guard must compare the
 * *set* — an order-sensitive key would make a slow per-file fetch bail and leave
 * the diff pane stuck on `loading`. */
const selectionKey = (diff?: { commits: string[]; workingBase?: string | null } | null): string | null =>
  diff ? `${diff.workingBase ?? ""}|${[...diff.commits].sort().join(",")}` : null;

function fileDiffForRoute(
  repoPath: string,
  path: string,
  route: CommitDiffRoute,
  full?: boolean,
) {
  switch (route.kind) {
    case COMMIT_DIFF_ROUTE.WorkingUnion:
      return api.compareFileDiff(repoPath, route.base, null, path, full);
    case COMMIT_DIFF_ROUTE.Selection:
      return api.selectionDiffFile(repoPath, route.commits, path, full);
    case COMMIT_DIFF_ROUTE.Commit:
      return api.commitFileDiff(repoPath, route.oid, path, full);
    case COMMIT_DIFF_ROUTE.Working:
      return api.fileDiff(repoPath, path, route.staged, full);
  }
}

export function createCommitSelectionActions(
  set: RepoSet,
  get: RepoGet,
  fileHistoryGen: FileHistoryGenerations,
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
> {
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
      fileHistoryGen.invalidate();
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
      // commit. Anchor on the sentinel instead — it is kept only while the WIP
      // row is really in the pick (see `nextAnchor`), never as a stale oid.
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
      // Once WIP leaves the pick its sentinel must leave the anchor with it, or
      // the next shift-click would range from a row that is no longer selected
      // and quietly pull the working tree back into the diff.
      const nextAnchor = anchor === WIP_SELECTION_ID && !wipSelected ? null : anchor;

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
        selectionAnchor: nextAnchor,
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
      const { summary, selectedCommit, selectionDiff, wipSelected } = get();
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
        const fileDiff = await fileDiffForRoute(
          repoPath,
          path,
          commitDiffRoute({ source, wipSelected, selectedCommit, selectionDiff }),
        );
        if (!fresh()) return;
        set({ fileDiff, diffLoading: false });
      } catch (e) {
        if (!fresh()) return;
        set({ diffLoading: false, error: String(e) });
      }
    },

    loadFullFileDiff: async () => {
      const { summary, selectedFile, selectedCommit, selectionDiff, wipSelected } = get();
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
        const fileDiff = await fileDiffForRoute(
          repoPath,
          path,
          commitDiffRoute({ source, wipSelected, selectedCommit, selectionDiff }),
          true,
        );
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

  };
}
