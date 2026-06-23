// Central app state. Keeps the open repo, its graph + branches, and the
// current selection. Async actions call the Rust layer via `api`.

import { create } from "zustand";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  type BranchInfo,
  type FileChange,
  type FileDiff,
  type RepoGraph,
  type RepoSummary,
  type StashEntry,
  type WorkingChanges,
  type WorktreeInfo,
} from "../lib/api";
import { splitCommitMessage } from "../lib/commitMessage";
import { useUi } from "./ui";
import { useAccounts } from "./accounts";
import { usePulls } from "./pulls";
import { computeSelection, validateSquashRange } from "./selection";
import { persistSession, readLastPath, readOpenPaths } from "./repoSession";
import {
  beginGraphRequest,
  claimOpenIntent,
  deferRefresh,
  graphGenerationIsCurrent,
  openIntentIsCurrent,
  takePendingRefresh,
} from "./repoRequests";

export type ChangeSource = "unstaged" | "staged" | "commit";

export interface SelectedFile {
  path: string;
  source: ChangeSource;
}

export const INITIAL_GRAPH_LIMIT = 2_000;
export const GRAPH_PAGE_SIZE = 2_000;

interface RepoState {
  summary: RepoSummary | null;
  graph: RepoGraph | null;
  branches: BranchInfo[];
  worktrees: WorktreeInfo[];
  stashes: StashEntry[];
  /** Paths of all open repositories — the tab strip. */
  openPaths: string[];
  changes: WorkingChanges;
  commitFiles: FileChange[];
  selectedFile: SelectedFile | null;
  fileDiff: FileDiff | null;
  selectedCommit: string | null;
  /** All currently selected commit ids (range or additive multi-select). The
   * focus/primary commit [`selectedCommit`] is always a member; single-select
   * is just the `length === 1` case. Kept in sync by [`selectCommitMulti`]. */
  selectedCommits: string[];
  /** The start of an in-progress shift-click range selection. Shift-clicking
   * extends from this anchor to the clicked commit. Null after a plain click. */
  selectionAnchor: string | null;
  /** True when the uncommitted "WIP" node is the current selection (inspected
   * in the right panel like a commit, rather than opening the changes view). */
  wipSelected: boolean;
  /** A pending request to scroll the graph to this commit, raised when the user
   * picks a branch in the navigator. HistoryWorkspace consumes it (scrolls the
   * row into view, then clears it); App watches it to flip back to the graph tab
   * when the pick happened on another page. */
  revealTarget: string | null;
  /** Number of commits requested from the graph command. Preserved across
   * refreshes so loading more history is not undone by the next watcher event. */
  graphLimit: number;
  loading: boolean;
  /** True while the initial commit graph for a freshly opened repo is still in
   * flight. Decoupled from [`loading`] so the app shell + history skeleton can
   * paint as soon as the (cheap) summary lands, without waiting on the heavy
   * graph payload. Only set during [`loadRepo`]; a [`refresh`] keeps the old
   * graph visible, so it never flips this. */
  graphLoading: boolean;
  loadingMoreHistory: boolean;
  diffLoading: boolean;
  error: string | null;

  pickAndOpen: () => Promise<void>;
  loadRepo: (path: string) => Promise<void>;
  closeRepo: (path: string) => Promise<void>;
  restoreSession: () => Promise<void>;
  /** Re-read repo state from disk. `scope: "worktree"` updates only working
   * changes, avoiding a graph rebuild for ordinary file/index watcher events. */
  refresh: (opts?: {
    prs?: boolean;
    quiet?: boolean;
    scope?: "all" | "worktree";
  }) => Promise<void>;
  /** Request the next bounded page of graph history. */
  loadMoreHistory: () => Promise<void>;
  selectCommit: (id: string | null) => Promise<void>;
  /** Select `id`, surface the graph, and request a scroll to it. Used by the
   * branch navigator so picking a branch jumps the graph to that branch's tip. */
  revealCommit: (id: string) => Promise<void>;
  /** Select the history tab and scroll to a synthetic stash row without
   * selecting the stash's file list in the inspector. */
  revealStash: (oid: string) => void;
  /** Clear the pending graph-reveal once HistoryWorkspace has scrolled to it. */
  consumeReveal: () => void;
  /**
   * Select a commit honouring modifier keys:
   * - plain click → single select (replaces any selection); becomes the anchor.
   * - additive (cmd/ctrl) → toggle the commit in/out of the selection; the
   *   focus commit moves to it when added.
   * - shift → select the contiguous range from [`selectionAnchor`] to `id`
   *   (the commits array is in graph/display order, so it's a plain slice).
   * The focus commit [`selectedCommit`] is always kept in the selection and
   * its files are fetched for the right panel.
   */
  selectCommitMulti: (
    id: string,
    mods?: { shift?: boolean; additive?: boolean },
    /** Commit ids in display order to range over for shift-select. Defaults to
     * the full graph — which is what the History view uses: search highlights
     * (dims non-matches) rather than hiding rows, so every commit stays visible
     * and a shift-range spans the whole DAG. An override is only needed by a
     * view that genuinely hides rows. */
    orderedIds?: string[],
  ) => Promise<void>;
  /** Clear every selected commit (used after a destructive batch op). */
  clearSelection: () => void;
  /** Select the uncommitted WIP node (inspect working changes in the panel). */
  selectWip: () => void;
  selectFile: (path: string, source: ChangeSource) => Promise<void>;
  /** Re-fetch the currently selected file's diff uncapped (the "show full diff"
   * action when a large diff was truncated by the backend line limit). */
  loadFullFileDiff: () => Promise<void>;
  clearSelectedFile: () => void;
  /** Checkout `name`; resolves with a toast message, throws the git error so
   * callers can surface it (the global error bar is reserved for open/refresh). */
  checkoutBranch: (name: string) => Promise<string>;
  createBranchAt: (name: string, startPoint?: string) => Promise<string>;
  removeBranch: (name: string, force?: boolean) => Promise<string>;
  renameBranchTo: (oldName: string, newName: string) => Promise<string>;
  /** Set `branch`'s upstream to the remote-tracking ref `upstream`. */
  setUpstreamFor: (branch: string, upstream: string) => Promise<string>;
  /** Push a branch that isn't necessarily checked out, to its configured
   * remote (origin fallback). */
  pushBranch: (branch: string) => Promise<string>;
  mergeInto: (from: string, to: string) => Promise<string>;
  fastForwardTo: (from: string, to: string) => Promise<string>;
  rebaseOnto: (onto: string) => Promise<string>;
  resetCurrentTo: (target: string, mode: "soft" | "mixed" | "hard") => Promise<string>;
  applyStash: (index: number, pop: boolean, withIndex?: boolean) => Promise<string>;
  /** Check out `branch` at the stash's parent and apply the stash there. */
  branchFromStash: (index: number, branch: string) => Promise<string>;
  dropStash: (index: number) => Promise<string>;
  cherryPickCommit: (sha: string) => Promise<string>;
  revertCommit: (sha: string) => Promise<string>;
  /** Cherry-pick several commits atomically (single git invocation). */
  cherryPickMany: (shas: string[]) => Promise<string>;
  /** Revert several commits atomically (single git invocation). */
  revertMany: (shas: string[]) => Promise<string>;
  /**
   * Squash a contiguous selection ending at HEAD into one commit. Implemented
   * as `git reset --soft <parent-of-oldest>` then `git commit` — collapses the
   * commits on top of their common ancestor. Throws if the selection isn't a
   * contiguous tip range (squashing non-tip commits needs interactive rebase).
   */
  squashSelection: (shas: string[], message: string) => Promise<string>;
  /** Create a lightweight tag at `sha` (defaults to HEAD). */
  createTagAt: (name: string, sha?: string) => Promise<string>;
  /** Create an annotated tag (with `message`) at `sha` (defaults to HEAD). */
  createAnnotatedTagAt: (name: string, message: string, sha?: string) => Promise<string>;
  /** Delete a local tag. */
  deleteTag: (name: string) => Promise<string>;
  /** Push a tag to origin as the repo's bound account. */
  pushTag: (name: string) => Promise<string>;
  /** Remove a linked worktree (`force` drops the dirty/locked check). */
  removeWorktree: (worktreePath: string, force?: boolean) => Promise<string>;
  /** Delete a branch on its remote. `remote`/`branch` are split from the
   * remote-tracking ref name (e.g. `origin/feature` → `origin`, `feature`). */
  deleteRemoteBranch: (remote: string, branch: string) => Promise<string>;
  /** Force-push `branch` with `--force-with-lease` (only that branch). */
  forcePush: (branch: string) => Promise<string>;
  /** Discard every uncommitted working-tree change (reset --hard + clean). */
  discardAll: () => Promise<string>;
  /** Write a `.patch` file for one commit into the worktree. */
  createPatchAt: (sha: string) => Promise<string>;
  /** Create a worktree at `worktreePath` checked out to `reference`, then open
   * it as a repo tab. */
  createWorktreeAt: (worktreePath: string, reference: string) => Promise<string>;
  /** Switch the app to an existing worktree (opens its path as a repo tab). */
  openWorktree: (worktreePath: string) => Promise<void>;
  /** Open the combined-diff review for a commit range base..head. */
  compareRange: (base: string, head: string, title: string) => void;
  checkoutDetached: (sha: string) => Promise<string>;
  stageFile: (path: string) => Promise<void>;
  unstageFile: (path: string) => Promise<void>;
  /** Discard a file's working-tree changes (unstaging first when `staged`). */
  discardFile: (path: string, staged: boolean) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  commit: (summary: string, description: string, amend: boolean) => Promise<void>;
  /** Reword the previous commit when it has not been pushed. */
  amendHeadMessage: (summary: string, description: string) => Promise<string>;
  /** Commit the staged set minus `excludePaths` (those are unstaged first, so
   * they survive as working changes), with `message` as the summary. Backs the
   * Commit-Changes modal's per-file checkboxes. */
  commitSelected: (message: string, excludePaths: string[], amend?: boolean) => Promise<void>;
  stash: () => Promise<void>;
  fetch: () => Promise<void>;
  pull: () => Promise<void>;
  push: () => Promise<void>;
  clearError: () => void;
}

const emptyChanges: WorkingChanges = { staged: [], unstaged: [] };

// Store-side glue over the pure request-coordination primitives in
// `repoRequests.ts`: a graph response is "current" only if it owns both the
// latest graph generation AND the displayed repo path.
const graphRequestIsCurrent = (generation: number, path: string) =>
  graphGenerationIsCurrent(generation) && useRepo.getState().summary?.path === path;

// Replay a re-sync deferred while `loading` was held (no-op when none queued).
const flushPendingRefresh = () => {
  const scope = takePendingRefresh();
  if (scope) void useRepo.getState().refresh({ prs: false, quiet: true, scope });
};

// Shared body for the branch/history write ops: require an open repo, run the
// op, refresh the graph, and return its toast message. Rejects (for the caller
// to toast) when there's no repo or the git op throws.
async function runOp(
  get: () => RepoState,
  body: (summary: RepoSummary) => Promise<string>,
): Promise<string> {
  const { summary } = get();
  if (!summary) throw new Error("No repository");
  const message = await body(summary);
  await get().refresh();
  return message;
}

export const useRepo = create<RepoState>((set, get) => ({
  summary: null,
  graph: null,
  branches: [],
  worktrees: [],
  stashes: [],
  openPaths: readOpenPaths(),
  changes: emptyChanges,
  commitFiles: [],
  selectedFile: null,
  fileDiff: null,
  selectedCommit: null,
  selectedCommits: [],
  selectionAnchor: null,
  wipSelected: false,
  revealTarget: null,
  graphLimit: INITIAL_GRAPH_LIMIT,
  loading: false,
  graphLoading: false,
  loadingMoreHistory: false,
  diffLoading: false,
  error: null,

  // Native folder picker → open whatever repo lives there.
  pickAndOpen: async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") {
      await get().loadRepo(picked);
    }
  },

  loadRepo: async (path: string) => {
    // Claim the latest open intent before doing anything that can await. A newer
    // pick supersedes this one even if our open resolves later (GL-20 review).
    const intent = claimOpenIntent();

    // Phase 1 — open the repo. This is a cheap libgit2 metadata read and the only
    // step that can fail "this isn't a repo". Crucially it touches NO shared
    // state: it doesn't bump the graph generation or raise the loading flags. So
    // a failed pick (invalid folder) can't supersede an in-flight load for the
    // repo that's still on screen, nor strand its summary over an empty graph —
    // it only surfaces the error, leaving the current repo (and any pending graph
    // request) untouched. See GL-20.
    let summary: RepoSummary;
    try {
      summary = await api.openRepo(path);
    } catch (e) {
      // Only surface the error if this is still the latest pick — a slow failed
      // open must not error over a repo the user has since switched to.
      if (openIntentIsCurrent(intent)) set({ error: String(e) });
      return;
    }
    // A newer pick superseded us while we were opening → drop this stale open so
    // it can't publish over the repo the user landed on.
    if (!openIntentIsCurrent(intent)) return;

    // Phase 2 — commit to the switch. Bump the generation (superseding any
    // in-flight graph request) and, in one atomic commit, publish the new summary,
    // drop the previous repo's graph/refs/changes, and raise the loading +
    // skeleton flags. The bump and this set share a synchronous tick, so no other
    // load can interleave between them.
    const generation = beginGraphRequest();
    const openPaths = get().openPaths.includes(summary.path)
      ? get().openPaths
      : [...get().openPaths, summary.path];
    persistSession(openPaths, summary.path);
    set({
      summary,
      openPaths,
      graph: null,
      branches: [],
      worktrees: [],
      stashes: [],
      changes: emptyChanges,
      loading: true,
      graphLoading: true,
      error: null,
      selectedCommit: null,
      selectedCommits: [],
      selectionAnchor: null,
      wipSelected: false,
      revealTarget: null,
      selectedFile: null,
      fileDiff: null,
      commitFiles: [],
      graphLimit: INITIAL_GRAPH_LIMIT,
      loadingMoreHistory: false,
    });

    // Watch the new worktree as soon as the shell swaps — before the graph — so a
    // commit/checkout during the (slow) graph load still triggers a refresh, the
    // watcher never lingers on the previous repo after a switch, and a graph
    // failure below can't leave the now-active repo unwatched (GL-20 review).
    void api.watchRepo(summary.workdir ?? summary.path).catch(() => {});

    // Reset PR state and resolve the new repo's account binding the moment the
    // summary is published — before awaiting the graph — so the ActionBar can't
    // pair the new repo's summary with the previous repo's PRs during a slow graph
    // load, and a graph failure can't strand stale PR state (GL-20 review).
    usePulls.getState().reset();
    // Resolve this repo's bound account, then fetch its PRs as that account.
    useAccounts.getState().syncRepoAccount(summary.path);
    // Quiet: just to populate the PRs badge; the panel isn't shown yet, and
    // opening it does its own foreground (spinner-visible) load.
    void usePulls.getState().loadPullRequests(false, true);

    // Secondary reads don't gate the first paint, so fan them out independently
    // — each fills its slice as it lands rather than waiting behind the graph in
    // one Promise.all. The generation + path guard drops responses from a
    // superseded or closed repo.
    //
    // Branches and working changes are *required* state: an empty navigator or a
    // falsely-clean worktree would be wrong, not merely incomplete, so a failure
    // surfaces on the global error bar (matching the pre-fan-out Promise.all,
    // whose rejection aborted the open). Worktrees and stashes stay best-effort —
    // a missing one degrades gracefully to an empty list.
    void api
      .listBranches(summary.path)
      .then((branches) => {
        if (graphRequestIsCurrent(generation, summary.path)) set({ branches });
      })
      .catch((e) => {
        if (graphRequestIsCurrent(generation, summary.path)) set({ error: String(e) });
      });
    void api
      .listWorktrees(summary.path)
      .then((worktrees) => {
        if (graphRequestIsCurrent(generation, summary.path)) set({ worktrees });
      })
      .catch(() => {});
    void api
      .listStashes(summary.path)
      .then((stashes) => {
        if (graphRequestIsCurrent(generation, summary.path)) set({ stashes });
      })
      .catch(() => {});
    void api
      .workingChanges(summary.path)
      .then((changes) => {
        if (graphRequestIsCurrent(generation, summary.path)) set({ changes });
      })
      .catch((e) => {
        if (graphRequestIsCurrent(generation, summary.path)) set({ error: String(e) });
      });

    // The graph is the heavy one — await it, then paint and pick the initial
    // selection once it lands, clearing the history skeleton.
    try {
      const graph = await api.commitGraph(summary.path, INITIAL_GRAPH_LIMIT);
      if (!graphRequestIsCurrent(generation, summary.path)) return;
      // Honor a selection the user made while the skeleton was up — the branch
      // navigator stays usable during the load, and picking a branch sets the
      // selection + revealTarget to its tip. Phase 2 cleared the selection, so a
      // non-null one here is a deliberate during-load pick; snapping it back to
      // the tip would scroll the graph to their branch while the inspector still
      // showed HEAD (GL-20 review). Its files were already fetched by the pick.
      const priorSelection = get().selectedCommit;
      const honorPrior = priorSelection != null;
      const selectedCommit = honorPrior ? priorSelection : graph.commits[0]?.id ?? null;
      set({
        graph,
        selectedCommit,
        selectedCommits: honorPrior ? get().selectedCommits : selectedCommit ? [selectedCommit] : [],
        selectionAnchor: honorPrior ? get().selectionAnchor : selectedCommit,
        ...(honorPrior ? {} : { commitFiles: [] }),
        graphLimit: INITIAL_GRAPH_LIMIT,
        graphLoading: false,
        loading: false,
      });
      // Commit-file loading is secondary to showing a usable history. Populate
      // the inspector after the graph is visible (only when we defaulted to the
      // tip — a during-load pick fetched its own files), and ignore a stale
      // response if the user switches repository/selection in the meantime.
      if (selectedCommit && !honorPrior) {
        void api
          .commitFiles(summary.path, selectedCommit)
          .then((commitFiles) => {
            if (
              graphRequestIsCurrent(generation, summary.path) &&
              get().selectedCommit === selectedCommit
            ) {
              set({ commitFiles });
            }
          })
          .catch(() => {});
      }
      // Replay any watcher/focus re-sync that arrived while this load held `loading`.
      flushPendingRefresh();
    } catch (e) {
      // Only clear the loading flags if this request still owns the active repo —
      // a newer load may have superseded us while the graph was in flight.
      if (!graphRequestIsCurrent(generation, summary.path)) return;
      set({ loading: false, graphLoading: false, error: String(e) });
      flushPendingRefresh();
    }
  },

  // Close a repo tab. If it was the active one, switch to a neighbour, or fall
  // back to the welcome screen when none remain.
  closeRepo: async (path) => {
    const { openPaths, summary } = get();
    const remaining = openPaths.filter((p) => p !== path);
    const wasActive = summary?.path === path;
    if (!wasActive) {
      persistSession(remaining, summary?.path ?? null);
      set({ openPaths: remaining });
      return;
    }
    if (remaining.length === 0) {
      persistSession([], null);
      set({
        openPaths: [],
        summary: null,
        graph: null,
        branches: [],
        worktrees: [],
        changes: emptyChanges,
        commitFiles: [],
        selectedCommit: null,
        selectedCommits: [],
        selectionAnchor: null,
        revealTarget: null,
        graphLimit: INITIAL_GRAPH_LIMIT,
        // Clear the loading flags: closing the tab orphans any in-flight graph
        // request (its summary-path guard now fails), so it can't clear them
        // itself and `loading` would otherwise stick true (GL-20 review).
        loading: false,
        graphLoading: false,
        loadingMoreHistory: false,
        selectedFile: null,
        fileDiff: null,
      });
      usePulls.getState().reset();
      return;
    }
    const next = remaining[Math.max(0, openPaths.indexOf(path) - 1)] ?? remaining[0];
    // Remove the closing repo's data before the replacement load. If opening
    // the neighbour fails, the UI shows a clean error state rather than keeping
    // a summary whose tab no longer exists.
    set({
      openPaths: remaining,
      summary: null,
      graph: null,
      branches: [],
      worktrees: [],
      stashes: [],
      changes: emptyChanges,
      commitFiles: [],
      selectedCommit: null,
      selectedCommits: [],
      selectionAnchor: null,
      revealTarget: null,
      graphLimit: INITIAL_GRAPH_LIMIT,
      // Reset the loading flags before the replacement load: the closing tab's
      // in-flight graph request is now orphaned, and if loadRepo(next) fails at
      // open_repo its phase-1 catch only sets `error`, so these would otherwise
      // stay stuck from the closed tab (GL-20 review).
      loading: false,
      graphLoading: false,
      loadingMoreHistory: false,
      selectedFile: null,
      fileDiff: null,
    });
    persistSession(remaining, next);
    await get().loadRepo(next);
  },

  // On launch, reopen the last active repository (tabs are restored from
  // localStorage in the initial state).
  restoreSession: async () => {
    const last = readLastPath();
    if (last) await get().loadRepo(last);
  },

  refresh: async (opts) => {
    const { summary, graphLimit, loading } = get();
    if (!summary) return;
    // A load (or a manual refresh) holds `loading` while a graph is in flight.
    // Don't drop a watcher/focus re-sync that lands in that window — defer it,
    // keeping the most permissive scope, and replay once the blocker clears
    // (GL-20 review). A full re-sync also can't run concurrently here: it would
    // race the in-flight graph fetch and could livelock a slow initial open.
    if (loading) {
      deferRefresh(opts?.scope === "worktree" ? "worktree" : "all");
      return;
    }
    const generation = opts?.scope === "worktree" ? null : beginGraphRequest();
    if (generation !== null) set({ loadingMoreHistory: false });
    if (!opts?.quiet) set({ loading: true, error: null });
    try {
      if (opts?.scope === "worktree") {
        const changes = await api.workingChanges(summary.path);
        if (get().summary?.path !== summary.path) return;
        const selectedFile = get().selectedFile;
        const selectedFileGone =
          selectedFile &&
          selectedFile.source !== "commit" &&
          !changes.staged.some((file) => file.path === selectedFile.path) &&
          !changes.unstaged.some((file) => file.path === selectedFile.path);
        const noWip = changes.staged.length === 0 && changes.unstaged.length === 0;
        set({
          changes,
          // Only clear the spinner if this call owned it (non-quiet). The quiet
          // watcher path never set it, so it must not clear a concurrent load's.
          ...(opts?.quiet ? {} : { loading: false }),
          ...(selectedFileGone ? { selectedFile: null, fileDiff: null } : {}),
          ...(get().wipSelected && noWip ? { wipSelected: false } : {}),
        });
        return;
      }

      const [nextSummary, graph, branches, worktrees, stashes, changes] = await Promise.all([
        api.openRepo(summary.path),
        api.commitGraph(summary.path, graphLimit),
        api.listBranches(summary.path),
        api.listWorktrees(summary.path).catch(() => []),
        api.listStashes(summary.path).catch(() => []),
        api.workingChanges(summary.path),
      ]);
      if (generation === null || !graphRequestIsCurrent(generation, summary.path)) {
        // Superseded mid-flight: replay any sync deferred during this refresh's
        // loading window so the coalesced event isn't lost on this bail (GL-20).
        flushPendingRefresh();
        return;
      }
      const currentSelection = get().selectedCommit;
      const selectedCommit =
        currentSelection && graph.commits.some((commit) => commit.id === currentSelection)
          ? currentSelection
          : graph.commits[0]?.id ?? null;
      const commitFiles = selectedCommit ? await api.commitFiles(nextSummary.path, selectedCommit) : [];
      if (!graphRequestIsCurrent(generation, summary.path)) {
        flushPendingRefresh();
        return;
      }
      // Trim the multi-selection to ids that still exist after the refresh —
      // e.g. a reset/rebase can drop the selected commits. Anchor stays if it
      // survives; otherwise it tracks the new focus commit.
      const liveIds = new Set(graph.commits.map((c) => c.id));
      const prevMulti = get().selectedCommits.filter((id) => liveIds.has(id));
      const selectedCommits =
        prevMulti.length > 0
          ? Array.from(new Set(selectedCommit ? [selectedCommit, ...prevMulti] : prevMulti))
          : selectedCommit
            ? [selectedCommit]
            : [];
      const selectionAnchor =
        get().selectionAnchor && liveIds.has(get().selectionAnchor!)
          ? get().selectionAnchor
          : selectedCommit;
      // Drop a selected working-tree file that no longer has changes (e.g. it
      // was committed/discarded outside the app) so the diff pane can't go stale.
      const sel = get().selectedFile;
      const gone =
        sel &&
        sel.source !== "commit" &&
        !changes.staged.some((f) => f.path === sel.path) &&
        !changes.unstaged.some((f) => f.path === sel.path);
      // If the WIP node was selected but there are no more changes, drop it.
      const noWip = changes.staged.length === 0 && changes.unstaged.length === 0;
      set({
        summary: nextSummary,
        graph,
        branches,
        worktrees,
        stashes,
        changes,
        selectedCommit,
        selectedCommits,
        selectionAnchor,
        commitFiles,
        loading: false,
        ...(gone ? { selectedFile: null, fileDiff: null } : {}),
        ...(get().wipSelected && noWip ? { wipSelected: false } : {}),
      });
      if (opts?.prs !== false) void usePulls.getState().loadPullRequests(false, true);
      // A non-quiet refresh held `loading`; replay anything deferred during it.
      flushPendingRefresh();
    } catch (e) {
      if (generation !== null && !graphRequestIsCurrent(generation, summary.path)) {
        flushPendingRefresh();
        return;
      }
      set({ loading: false, error: String(e) });
      flushPendingRefresh();
    }
  },

  loadMoreHistory: async () => {
    const { summary, graph, graphLimit, loading, loadingMoreHistory } = get();
    if (!summary || !graph?.truncated || loading || loadingMoreHistory) return;
    const nextLimit = graphLimit + GRAPH_PAGE_SIZE;
    const generation = beginGraphRequest();
    set({ loadingMoreHistory: true, loading: false });
    try {
      const nextGraph = await api.commitGraph(summary.path, nextLimit);
      if (!graphRequestIsCurrent(generation, summary.path)) return;
      set({
        graph: nextGraph,
        graphLimit: nextLimit,
        loadingMoreHistory: false,
      });
    } catch (error) {
      if (!graphRequestIsCurrent(generation, summary.path)) return;
      set({ loadingMoreHistory: false });
      useUi.getState().showToast(String(error), "error");
    }
  },

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
    const ids = orderedIds ?? graph?.commits.map((c) => c.id) ?? [];
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

  checkoutBranch: async (name) => {
    const { summary } = get();
    if (!summary) throw new Error("No repository");
    set({ loading: true, error: null });
    try {
      await api.checkout(summary.path, name);
      set({ loading: false });
      await get().refresh();
      return `Checked out ${name}`;
    } catch (e) {
      // Reset the spinner but let the caller present the failure (toast), so a
      // failed checkout never leaves a stale success message behind.
      set({ loading: false });
      throw e;
    }
  },

  // Branch operations. Each refreshes the graph and returns a human-readable
  // message for the caller to surface as a toast; failures reject with the
  // git error so the caller can toast that instead.
  createBranchAt: (name, startPoint) =>
    runOp(get, async (summary) => {
      await api.createBranch(summary.path, name, startPoint);
      await api.checkout(summary.path, name);
      return `Created ${name}`;
    }),

  removeBranch: (name, force = false) =>
    runOp(get, async (summary) => {
      await api.deleteBranch(summary.path, name, force);
      return `Deleted ${name}`;
    }),

  renameBranchTo: (oldName, newName) =>
    runOp(get, async (summary) => {
      await api.renameBranch(summary.path, oldName, newName);
      return `Renamed ${oldName} → ${newName}`;
    }),

  setUpstreamFor: (branch, upstream) =>
    runOp(get, async (summary) => {
      await api.setUpstream(summary.path, branch, upstream);
      return `Set upstream of ${branch} to ${upstream}`;
    }),

  pushBranch: (branch) =>
    runOp(get, async (summary) => {
      await api.pushBranch(summary.path, branch, useAccounts.getState().repoAccountRef);
      return `Pushed ${branch}`;
    }),

  mergeInto: (from, to) =>
    runOp(get, async (summary) => {
      if (summary.headBranch !== to) {
        try {
          await api.checkout(summary.path, to);
        } catch (e) {
          throw new Error(`Couldn't check out ${to} to merge into it: ${e}`);
        }
      }
      await api.mergeBranch(summary.path, from);
      return `Merged ${from} into ${to}`;
    }),

  // `from` is the rev to advance to; `to` is the branch being moved forward.
  // When `to` is the checked-out branch, fast-forward it in the working tree
  // (`merge --ff-only`). Otherwise move its ref in place without a disruptive
  // checkout — so e.g. advancing develop to origin/develop never yanks you off
  // the branch you're working on.
  fastForwardTo: (from, to) =>
    runOp(get, async (summary) => {
      if (summary.headBranch === to) await api.fastForward(summary.path, from);
      else await api.fastForwardBranch(summary.path, to, from);
      return `Fast-forwarded ${to} to ${from}`;
    }),

  rebaseOnto: (onto) =>
    runOp(get, async (summary) => {
      await api.rebaseOnto(summary.path, onto);
      return `Rebased onto ${onto}`;
    }),

  resetCurrentTo: (target, mode) =>
    runOp(get, async (summary) => {
      await api.resetTo(summary.path, target, mode);
      return `Reset to ${target}`;
    }),

  applyStash: (index, pop, withIndex) =>
    runOp(get, async (summary) => {
      if (pop) await api.stashPop(summary.path, index);
      else if (withIndex) await api.stashApplyIndex(summary.path, index);
      else await api.stashApply(summary.path, index);
      return pop ? "Popped stash" : "Applied stash";
    }),

  branchFromStash: (index, branch) =>
    runOp(get, async (summary) => {
      await api.stashBranch(summary.path, branch, index);
      return `Applied stash to new branch ${branch}`;
    }),

  dropStash: (index) =>
    runOp(get, async (summary) => {
      await api.stashDrop(summary.path, index);
      return "Dropped stash";
    }),

  cherryPickCommit: (sha) =>
    runOp(get, async (summary) => {
      await api.cherryPick(summary.path, sha);
      return `Cherry-picked ${sha.slice(0, 7)}`;
    }),

  revertCommit: (sha) =>
    runOp(get, async (summary) => {
      await api.revertCommit(summary.path, sha);
      return `Reverted ${sha.slice(0, 7)}`;
    }),

  checkoutDetached: (sha) =>
    runOp(get, async (summary) => {
      await api.checkout(summary.path, sha);
      return `Checked out ${sha.slice(0, 7)} (detached)`;
    }),

  cherryPickMany: async (shas) => {
    const msg = await runOp(get, async (summary) => {
      if (shas.length === 0) throw new Error("No commits selected");
      await api.cherryPickMany(summary.path, shas);
      return `Cherry-picked ${shas.length} commit${shas.length === 1 ? "" : "s"}`;
    });
    get().clearSelection();
    return msg;
  },

  revertMany: async (shas) => {
    const msg = await runOp(get, async (summary) => {
      if (shas.length === 0) throw new Error("No commits selected");
      await api.revertMany(summary.path, shas);
      return `Reverted ${shas.length} commit${shas.length === 1 ? "" : "s"}`;
    });
    get().clearSelection();
    return msg;
  },

  squashSelection: async (shas, message) => {
    const msg = await runOp(get, async (summary) => {
      // Soft-reset to the parent of the oldest selected commit, then commit the
      // staged tree as one. `reset --soft` keeps the working tree + index at the
      // newest commit, so the new commit's content equals the squashed range's.
      const parent = validateSquashRange(get().graph, shas);
      await api.resetTo(summary.path, parent, "soft");
      const identity = useAccounts.getState().repoIdentity;
      await api.commit(summary.path, message, "", false, identity?.name, identity?.email);
      return `Squashed ${shas.length} commits`;
    });
    get().clearSelection();
    return msg;
  },

  createTagAt: (name, sha) =>
    runOp(get, async (summary) => {
      await api.createTag(summary.path, name, sha);
      return `Created tag ${name}`;
    }),

  createAnnotatedTagAt: (name, message, sha) =>
    runOp(get, async (summary) => {
      await api.createAnnotatedTag(summary.path, name, message, sha);
      return `Created tag ${name}`;
    }),

  createPatchAt: (sha) =>
    runOp(get, async (summary) => {
      const file = await api.createPatch(summary.path, sha);
      return `Created patch ${file}`;
    }),

  deleteTag: (name) =>
    runOp(get, async (summary) => api.deleteTag(summary.path, name)),

  pushTag: (name) =>
    runOp(get, async (summary) => {
      await api.pushTag(summary.path, name, useAccounts.getState().repoAccountRef);
      return `Pushed tag ${name}`;
    }),

  removeWorktree: (worktreePath, force = false) =>
    runOp(get, async (summary) => api.removeWorktree(summary.path, worktreePath, force)),

  deleteRemoteBranch: (remote, branch) =>
    runOp(get, async (summary) => {
      await api.deleteRemoteBranch(summary.path, remote, branch, useAccounts.getState().repoAccountRef);
      return `Deleted ${remote}/${branch}`;
    }),

  forcePush: (branch) =>
    runOp(get, async (summary) => {
      await api.forcePush(summary.path, branch, useAccounts.getState().repoAccountRef);
      return `Force-pushed ${branch} (with lease)`;
    }),

  discardAll: () => runOp(get, async (summary) => api.discardAll(summary.path)),

  createWorktreeAt: async (worktreePath, reference) => {
    const { summary } = get();
    if (!summary) throw new Error("No repository");
    // Create the worktree against the current repo, then open the new path as
    // its own repo tab (loadRepo discovers + watches it).
    await api.addWorktree(summary.path, worktreePath, reference);
    await get().loadRepo(worktreePath);
    return `Created worktree at ${worktreePath}`;
  },

  openWorktree: async (worktreePath) => {
    await get().loadRepo(worktreePath);
  },

  compareRange: (base, head, title) => {
    useUi.getState().openRangeReview(base, head, title);
  },

  stageFile: async (path) => {
    const { summary } = get();
    if (!summary) return;
    try {
      await api.stageFile(summary.path, path);
      await get().refresh();
      await get().selectFile(path, "staged");
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    }
  },

  unstageFile: async (path) => {
    const { summary } = get();
    if (!summary) return;
    try {
      await api.unstageFile(summary.path, path);
      await get().refresh();
      await get().selectFile(path, "unstaged");
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    }
  },

  discardFile: async (path, staged) => {
    const { summary } = get();
    if (!summary) return;
    try {
      const message = await api.discardFile(summary.path, path, staged);
      await get().refresh();
      // The discarded view is now empty. `refresh` drops the selection when the
      // path leaves both buckets; but a partially-staged file can survive in the
      // other bucket with a now-stale `source` — re-point the diff at it so the
      // pane never shows an empty diff for a file that still has changes.
      const { selectedFile, changes } = get();
      if (selectedFile && selectedFile.source !== "commit" && selectedFile.path === path) {
        if (changes.unstaged.some((f) => f.path === path)) await get().selectFile(path, "unstaged");
        else if (changes.staged.some((f) => f.path === path)) await get().selectFile(path, "staged");
      }
      useUi.getState().showToast(message);
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    }
  },

  stageAll: async () => {
    const { summary } = get();
    if (!summary) return;
    try {
      await api.stageAll(summary.path);
      await get().refresh();
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    }
  },

  unstageAll: async () => {
    const { summary } = get();
    if (!summary) return;
    try {
      await api.unstageAll(summary.path);
      await get().refresh();
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    }
  },

  commit: async (summaryText, description, amend) => {
    const { summary } = get();
    if (!summary) return;
    // Pin the repo's bound identity (author + committer) so global-config
    // changes by other tools can never leak into a GitLane commit.
    const identity = useAccounts.getState().repoIdentity;
    try {
      await api.commit(summary.path, summaryText, description, amend, identity?.name, identity?.email);
      await get().refresh();
      set({ selectedFile: null, fileDiff: null });
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    }
  },

  amendHeadMessage: (summaryText, description) =>
    runOp(get, async (summary) => {
      const identity = useAccounts.getState().repoIdentity;
      await api.commit(summary.path, summaryText, description, true, identity?.name, identity?.email);
      return "Updated commit message";
    }),

  commitSelected: async (message, excludePaths, amend = false) => {
    const { summary } = get();
    if (!summary) return;
    const identity = useAccounts.getState().repoIdentity;
    try {
      // Files unchecked in the modal are dropped from this commit by unstaging
      // them first; they stay in the working tree.
      // Unstage the excluded set atomically so a partial failure can't leave
      // some of them staged.
      if (excludePaths.length > 0) await api.unstageFiles(summary.path, excludePaths);
      const { summary: subject, description } = splitCommitMessage(message);
      await api.commit(summary.path, subject, description, amend, identity?.name, identity?.email);
      await get().refresh();
      set({ selectedFile: null, fileDiff: null, wipSelected: false });
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    }
  },

  stash: async () => {
    const { summary } = get();
    if (!summary) return;
    try {
      await api.stash(summary.path);
      await get().refresh();
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    }
  },

  fetch: async () => {
    const { summary } = get();
    if (!summary) return;
      set({ loading: true, error: null });
    try {
      await api.fetch(summary.path, useAccounts.getState().repoAccountRef);
      set({ loading: false });
      await get().refresh();
    } catch (e) {
      set({ loading: false });
      useUi.getState().showToast(String(e), "error");
    }
  },

  pull: async () => {
    const { summary } = get();
    if (!summary) return;
    try {
      await api.pull(summary.path);
      await get().refresh();
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    }
  },

  push: async () => {
    const { summary } = get();
    if (!summary) return;
    try {
      await api.push(summary.path, useAccounts.getState().repoAccountRef);
      await get().refresh();
    } catch (e) {
      useUi.getState().showToast(String(e), "error");
    }
  },

  clearError: () => set({ error: null }),
}));
