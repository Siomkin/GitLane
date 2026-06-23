import type { StoreApi } from "zustand";
import type {
  BranchInfo,
  FileChange,
  FileDiff,
  RepoGraph,
  RepoSummary,
  StashEntry,
  WorkingChanges,
  WorktreeInfo,
} from "../lib/api";

export type ChangeSource = "unstaged" | "staged" | "commit";

export interface SelectedFile {
  path: string;
  source: ChangeSource;
}

export const INITIAL_GRAPH_LIMIT = 2_000;
export const GRAPH_PAGE_SIZE = 2_000;

export interface RepoState {
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

export type RepoSet = StoreApi<RepoState>["setState"];
export type RepoGet = StoreApi<RepoState>["getState"];

export type RepoDataState = Pick<
  RepoState,
  | "summary"
  | "graph"
  | "branches"
  | "worktrees"
  | "stashes"
  | "openPaths"
  | "changes"
  | "commitFiles"
  | "selectedFile"
  | "fileDiff"
  | "selectedCommit"
  | "selectedCommits"
  | "selectionAnchor"
  | "wipSelected"
  | "revealTarget"
  | "graphLimit"
  | "loading"
  | "graphLoading"
  | "loadingMoreHistory"
  | "diffLoading"
  | "error"
>;

export const emptyChanges: WorkingChanges = { staged: [], unstaged: [] };

export function createInitialRepoData(openPaths: string[]): RepoDataState {
  return {
    summary: null,
    graph: null,
    branches: [],
    worktrees: [],
    stashes: [],
    openPaths,
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
  };
}
