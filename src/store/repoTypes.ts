import type { StoreApi } from "zustand";
import type {
  BranchInfo,
  FileBlame,
  ConflictFile,
  DiffLine,
  FileChange,
  FileDiff,
  FileHistoryEntry,
  OperationKind,
  ReflogEntry,
  RepoForge,
  RepoGraph,
  RepoSummary,
  StashEntry,
  WorkingChanges,
  WorktreeInfo,
} from "../lib/api";
import type { RecentRepo } from "./repoSession";

export type ChangeSource = "unstaged" | "staged" | "commit";

/** A conflict-producing operation key, excluding the "none" idle sentinel. */
export type ActiveOperationKind = Exclude<OperationKind, "none">;

/** One file involved in the active operation, tracked across refreshes so the
 * count/progress stays stable as each conflict is resolved. */
export interface OperationFile extends ConflictFile {
  /** True once the file is no longer reported as conflicted (resolved + staged). */
  resolved: boolean;
}

/** The active merge/sequencer operation driving the conflict workflow. Null when
 * the repo is clean / no operation is underway. */
export interface OperationState {
  kind: ActiveOperationKind;
  canSkip: boolean;
  /** Stable union of every file the operation touched (still-conflicted +
   * already-resolved), so totals don't shrink as files are resolved. */
  files: OperationFile[];
}

export interface SelectedFile {
  path: string;
  source: ChangeSource;
}

export interface FileHistoryState {
  path: string;
  /** Which mode the inspection opened in / is showing. */
  mode: "history" | "blame";
  entries: FileHistoryEntry[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  nextOffset: number;
  truncated: boolean;
  selectedOid: string | null;
  selectedPath: string | null;
  selectedDiff: FileDiff | null;
  diffLoading: boolean;
  blame: FileBlame | null;
  blameLoading: boolean;
  /** Blame-specific error, kept out of [`error`] so a blame failure never
   * blanks the (successfully loaded) history list with a full-page error. */
  blameError: string | null;
  /** The revision the loaded blame is for — independent of [`selectedOid`] so
   * "blame previous revision" can target a parent without moving the list. */
  blameRevision: string | null;
  /** SHA of the blame line the user picked (drives the blame inspector). */
  blameSelectedOid: string | null;
}

/** Which two endpoints a compare view is showing. */
export type CompareScope = "upstream" | "branch" | "commit" | "working";

/** A `base..head` comparison surface (branch/commit ranges or working tree). */
export interface CompareState {
  /** Left (older) endpoint — a ref or oid passed to the backend. */
  base: string;
  /** Right (newer) endpoint, or null when comparing against the working tree. */
  head: string | null;
  baseLabel: string;
  headLabel: string;
  scope: CompareScope;
  title: string;
  files: FileChange[];
  loading: boolean;
  error: string | null;
  add: number;
  del: number;
  ahead: number;
  behind: number;
  pathFilter: string;
  selectedPath: string | null;
  selectedDiff: FileDiff | null;
  diffLoading: boolean;
  /** Per-file diff error, kept out of [`error`] so a diff failure never hides
   * the (loaded) changed-files list. */
  diffError: string | null;
}

export const INITIAL_GRAPH_LIMIT = 2_000;
export const GRAPH_PAGE_SIZE = 2_000;

export interface RepoState {
  summary: RepoSummary | null;
  /** The open repo's remote forge — drives the provider indicator and gates the
   * GitHub-only PR path (no `gh` resolution for non-GitHub remotes). */
  forge: RepoForge | null;
  graph: RepoGraph | null;
  branches: BranchInfo[];
  reflogEntries: ReflogEntry[];
  reflogLoading: boolean;
  reflogError: string | null;
  worktrees: WorktreeInfo[];
  stashes: StashEntry[];
  /** Paths of all open repositories — the tab strip. */
  openPaths: string[];
  /** Recently-opened repositories for the onboarding "Recent" list (most-recent
   * first). Updated on each successful open; persisted to localStorage. */
  recents: RecentRepo[];
  changes: WorkingChanges;
  /** The active merge/rebase/cherry-pick/revert operation + its conflicts, or
   * null when none is in progress. Refreshed with working-tree status; when
   * non-null the app surfaces the dedicated conflict-resolution workspace. */
  operation: OperationState | null;
  commitFiles: FileChange[];
  fileHistory: FileHistoryState | null;
  /** The active compare surface (branch/commit/working diff), or null. */
  compare: CompareState | null;
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
  /** Reorder the open repository tabs without changing the active repository. */
  reorderOpenPaths: (fromIndex: number, toIndex: number) => void;
  restoreSession: () => Promise<void>;
  /** Refresh recents' presence + current branch from disk (start-screen mount):
   * flags paths that no longer exist as `missing` and updates their branch. */
  refreshRecents: () => Promise<void>;
  /** Drop one recent entry (e.g. a missing path the user dismisses). */
  removeRecent: (path: string) => void;
  /** Clear the entire recent list. */
  clearRecents: () => void;
  /** Re-read repo state from disk. `scope: "worktree"` updates only working
   * changes, avoiding a graph rebuild for ordinary file/index watcher events. */
  refresh: (opts?: {
    prs?: boolean;
    quiet?: boolean;
    scope?: "all" | "worktree";
  }) => Promise<void>;
  /** Request the next bounded page of graph history. */
  loadMoreHistory: () => Promise<void>;
  loadReflog: () => Promise<void>;
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
  /** Push a branch to `remote/branch` and set that as its upstream. */
  publishBranch: (branch: string, upstream: string) => Promise<string>;
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
  /** Open a dedicated history-inspection page for a repo-relative file. */
  openFileHistory: (path: string, mode?: "history" | "blame") => Promise<void>;
  loadMoreFileHistory: () => Promise<void>;
  selectFileHistoryRevision: (oid: string, path?: string | null, full?: boolean) => Promise<void>;
  /** Blame `path` (defaults to the selected revision's path, so renames blame
   * the historical name) at `revision` (defaults to the selected revision). */
  loadFileBlame: (revision?: string | null, path?: string | null) => Promise<void>;
  /** Mark which blame line's commit is selected (drives the blame inspector). */
  selectBlameLine: (oid: string) => void;
  closeFileHistory: () => void;
  /** Open a compare surface between two endpoints. `head: null` compares the
   * base against the working tree. */
  openCompare: (opts: {
    base: string;
    head: string | null;
    baseLabel: string;
    headLabel: string;
    scope: CompareScope;
    title: string;
  }) => Promise<void>;
  selectCompareFile: (path: string, full?: boolean) => Promise<void>;
  /** Re-fetch the open comparison's file list + selected diff in place (used by
   * refresh so a working-tree compare reflects external edits/commits). */
  refreshCompare: () => Promise<void>;
  setComparePathFilter: (filter: string) => void;
  /** Swap base/head of a commit-range comparison and re-fetch (no-op for a
   * working-tree comparison, which has no second commit). */
  swapCompare: () => Promise<void>;
  closeCompare: () => void;
  checkoutDetached: (sha: string) => Promise<string>;
  stageFile: (path: string) => Promise<void>;
  unstageFile: (path: string) => Promise<void>;
  /** Stage one hunk from an unstaged diff, or unstage one hunk from a staged diff. */
  applyHunk: (
    path: string,
    staged: boolean,
    hunkIndex: number,
    expectedHeader: string,
    expectedBody: string,
  ) => Promise<void>;
  /** Stage one changed line from an unstaged diff, or unstage one changed line from a staged diff. */
  applyLine: (path: string, staged: boolean, hunkIndex: number, lineIndex: number, line: DiffLine) => Promise<void>;
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
  // ---- conflict resolution (active operation) ----
  // Each per-file action resolves to whether the git write succeeded; callers
  // gate local-state cleanup on `true` so a failed write never clears decisions.
  /** Resolve one conflicted file by taking a whole side (ours/theirs). */
  acceptConflictSide: (file: string, side: "ours" | "theirs") => Promise<boolean>;
  /** Write the merged `content` for a conflicted file and stage it. */
  resolveConflictFile: (file: string, content: string) => Promise<boolean>;
  /** Stage a conflicted file as-is (mark resolved after a manual edit). */
  markConflictResolved: (file: string) => Promise<boolean>;
  /** Restore conflict markers for an already-resolved file so it can be redone. */
  reconflictFile: (file: string) => Promise<boolean>;
  /** Continue the active operation after staging resolutions; resolves with a
   * human message (op complete vs. next conflicts). */
  continueOperation: () => Promise<string>;
  /** Abort the active operation, restoring the pre-operation state. */
  abortOperation: () => Promise<string>;
  /** Skip the current commit of a sequencer operation (rebase/cherry-pick/revert). */
  skipOperation: () => Promise<string>;
  clearError: () => void;
}

export type RepoSet = StoreApi<RepoState>["setState"];
export type RepoGet = StoreApi<RepoState>["getState"];

export type RepoDataState = Pick<
  RepoState,
  | "summary"
  | "forge"
  | "graph"
  | "branches"
  | "reflogEntries"
  | "reflogLoading"
  | "reflogError"
  | "worktrees"
  | "stashes"
  | "openPaths"
  | "recents"
  | "changes"
  | "operation"
  | "commitFiles"
  | "fileHistory"
  | "compare"
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

export const emptyChanges: WorkingChanges = { staged: [], unstaged: [], conflicted: [] };

export function createInitialRepoData(
  openPaths: string[],
  recents: RecentRepo[] = [],
): RepoDataState {
  return {
    summary: null,
    forge: null,
    graph: null,
    branches: [],
    reflogEntries: [],
    reflogLoading: false,
    reflogError: null,
    worktrees: [],
    stashes: [],
    openPaths,
    recents,
    changes: emptyChanges,
    operation: null,
    commitFiles: [],
    fileHistory: null,
    compare: null,
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
