// `RepoDataState` — the git data the store publishes for the open repo, plus
// the paging constants and the factory for its initial value.

import type {
  BranchInfo,
  FileChange,
  FileDiff,
  OperationAdvisory,
  ReflogEntry,
  RemoteInfo,
  RepoForge,
  RepoGraph,
  RepoSummary,
  StashEntry,
  WorkingChanges,
  WorktreeInfo,
} from "@/lib/api";
import type { RecentRepo } from "@/store/repoSession";
import type { TabInfo } from "@/lib/tabs";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import {
  CompareState,
  FileHistoryState,
  FileViewState,
  MissingRepoState,
  OperationState,
  RepoFilesState,
  SelectedFile,
  SelectionDiffState,
  SessionRestorePhase,
  SESSION_RESTORE_PHASE,
} from "./views";
export const INITIAL_GRAPH_LIMIT = 2_000;
export const GRAPH_PAGE_SIZE = 2_000;

/**
 * The repo store's *data* — every field that holds state rather than an action,
 * declared once (GL-356). `RepoState` extends it and `createInitialRepoData`
 * returns it, so a new field is one edit and the two can't drift. Note this is
 * the store's *initial* shape, not `loadRepo`'s reset list: a repo switch
 * deliberately carries `netOps`, `fetchingPath`, `sessionRestorePhase`, and
 * `initMissingRepoRunning` across.
 */
export interface RepoDataState {
  summary: RepoSummary | null;
  /** The open repo's remote forge — drives the provider indicator and gates the
   * GitHub-only PR path (no `gh` resolution for non-GitHub remotes). */
  forge: RepoForge | null;
  /** The open repo's configured remotes. Loaded with the other secondary reads
   * on open/refresh; per-remote account resolution (GL-129) and the Remotes
   * panel both read from here so they agree on the remote list. */
  remotes: RemoteInfo[];
  graph: RepoGraph | null;
  branches: BranchInfo[];
  reflogEntries: ReflogEntry[];
  reflogLoading: boolean;
  reflogError: string | null;
  worktrees: WorktreeInfo[];
  /** Paths of the *other* worktrees currently holding uncommitted work, driving
   * the graph's dirty dot. Filled by a throttled probe that runs after a refresh
   * rather than inside it — see `repoWorktreeDirty.ts` for why it isn't a field
   * on [`worktrees`]. Best-effort: an unprobed or failed worktree is simply
   * absent (no dot). */
  dirtyWorktrees: string[];
  stashes: StashEntry[];
  /** Paths of all open repositories — the tab strip. */
  openPaths: string[];
  /** Whether the persisted startup session still needs to be (or is being)
   * restored. Kept separate from [`loading`], which belongs to an open repo's
   * graph load and only starts after its summary has resolved. */
  sessionRestorePhase: SessionRestorePhase;
  /** The active tab whose repository path failed to resolve (GL-108), or null.
   * Mutually exclusive with a live [`summary`] — entering it clears the repo
   * data, and a successful open clears it back. */
  missingRepo: MissingRepoState | null;
  /** What the tab strip knows about each open path (worktree? of which repo?
   * on which branch?) — drives worktree-tab labels and grouped insertion
   * (GL-110). Filled from summaries as tabs open and from the session-restore
   * probe; a missing entry degrades to a plain repo tab. */
  tabInfoByPath: Record<string, TabInfo>;
  /** Recently-opened repositories for the onboarding "Recent" list (most-recent
   * first). Updated on each successful open; persisted to localStorage. */
  recents: RecentRepo[];
  /** The working-tree snapshot. Contract: every publish is a NEW object, even
   * when the content is identical — consumers use snapshot identity as their
   * cache generation (the changes view's diff cache, GL-173), so a future
   * deep-equal "optimization" that reused the reference would silently break
   * their invalidation. */
  changes: WorkingChanges;
  /** The active merge/rebase/cherry-pick/revert operation + its conflicts, or
   * null when none is in progress. Refreshed with working-tree status; when
   * non-null the app surfaces the dedicated conflict-resolution workspace. */
  operation: OperationState | null;
  /** A non-drivable in-progress git state (`git am` or bisect) surfaced as a
   * read-only advisory banner — GitLane can't continue/abort these in-app, so
   * they stay out of `operation` and the conflict workspace. Null when the repo
   * is clean or in a drivable operation. */
  operationAdvisory: OperationAdvisory | null;
  commitFiles: FileChange[];
  /** Which parent a merge commit's inspector diffs against (0 = first parent /
   * `commit_files`). Reset to 0 whenever [`selectedCommit`] changes. Ignored
   * for stashes and ordinary single-parent commits. */
  inspectParentIndex: number;
  /** The merged diff for a multi-commit selection (GL-68), or null when a single
   * commit (or none) is selected — then [`commitFiles`] drives the inspector. */
  selectionDiff: SelectionDiffState | null;
  fileHistory: FileHistoryState | null;
  /** The active compare surface (branch/commit/working diff), or null. */
  compare: CompareState | null;
  /** The Files-tab repository listing, or null before its first load. */
  repoFiles: RepoFilesState | null;
  /** A repository file opened read-only in the center pane, or null. */
  fileView: FileViewState | null;
  selectedFile: SelectedFile | null;
  /** Monotonic identity of repo-bound selection/center-route navigation. It
   * advances across commit, WIP, working-file, repository-file, history, and
   * compare transitions, including re-selecting the active file, so async
   * follow-ups cannot revive a route the user has since left. */
  fileSelectionRequestId: number;
  fileDiff: FileDiff | null;
  selectedCommit: string | null;
  /** All currently selected commit ids (range or additive multi-select). The
   * focus/primary commit [`selectedCommit`] is always a member; single-select
   * is just the `length === 1` case. Kept in sync by [`selectCommitMulti`]. */
  selectedCommits: string[];
  /** The start of an in-progress shift-click range selection. Shift-clicking
   * extends from this anchor to the clicked commit. Null after a plain click. */
  selectionAnchor: string | null;
  /** True when the uncommitted "WIP" node is part of the current selection
   * (inspected in the right panel like a commit, rather than opening the changes
   * view). It can be set alongside a non-empty `selectedCommits` — that pick is
   * one merged diff ending at the working tree (`selectionDiff.workingBase`). */
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
  /** Count of in-flight network git operations (fetch/pull/push/publish/…). The
   * store transport mutex admits at most one; the auto-fetch scheduler checks
   * this too so a background fetch skips instead of surfacing a busy error. */
  netOps: number;
  /** Repository whose remote refs are currently being fetched, if any. Kept
   * separate from [`loading`] so a quiet automatic fetch can drive the Fetch
   * button without blocking the rest of the app shell. */
  fetchingPath: string | null;
  /** True while the initial commit graph for a freshly opened repo is still in
   * flight. Decoupled from [`loading`] so the app shell + history skeleton can
   * paint as soon as the (cheap) summary lands, without waiting on the heavy
   * graph payload. Only set during [`loadRepo`]; a [`refresh`] keeps the old
   * graph visible, so it never flips this. */
  graphLoading: boolean;
  loadingMoreHistory: boolean;
  diffLoading: boolean;
  error: string | null;
  /** True while [`initMissingRepo`] is in flight — disables the button so a
   * double-click can't fire two inits. */
  initMissingRepoRunning: boolean;
}

export const emptyChanges: WorkingChanges = {
  staged: [],
  unstaged: [],
  conflicted: [],
  advanced: emptyAdvancedState,
};

export function createInitialRepoData(
  openPaths: string[],
  recents: RecentRepo[] = [],
  tabInfoByPath: Record<string, TabInfo> = {},
  sessionRestorePhase: SessionRestorePhase = SESSION_RESTORE_PHASE.Complete,
): RepoDataState {
  return {
    summary: null,
    forge: null,
    remotes: [],
    graph: null,
    branches: [],
    reflogEntries: [],
    reflogLoading: false,
    reflogError: null,
    worktrees: [],
    dirtyWorktrees: [],
    stashes: [],
    openPaths,
    sessionRestorePhase,
    missingRepo: null,
    initMissingRepoRunning: false,
    tabInfoByPath,
    recents,
    changes: emptyChanges,
    operation: null,
    operationAdvisory: null,
    commitFiles: [],
    inspectParentIndex: 0,
    selectionDiff: null,
    fileHistory: null,
    compare: null,
    repoFiles: null,
    fileView: null,
    selectedFile: null,
    fileSelectionRequestId: 0,
    fileDiff: null,
    selectedCommit: null,
    selectedCommits: [],
    selectionAnchor: null,
    wipSelected: false,
    revealTarget: null,
    graphLimit: INITIAL_GRAPH_LIMIT,
    loading: false,
    netOps: 0,
    fetchingPath: null,
    graphLoading: false,
    loadingMoreHistory: false,
    diffLoading: false,
    error: null,
  };
}

/** The canonical wipe for dropping a repo's data (GL-373): the initial empty
 * value of *every* `RepoDataState` field, so a field added to the state cannot
 * be forgotten at a wipe site — TypeScript and the wipe-completeness test both
 * enforce it. Each site spreads this into its `set` and adds only its genuine
 * deltas, including the fields that deliberately carry across a switch or
 * close (`netOps`, `fetchingPath`, `sessionRestorePhase`, `initMissingRepoRunning`,
 * `recents`, and the monotonic `fileSelectionRequestId`), which this resets
 * and a carry site must re-set from the current state. */
export function repoDataWipe(openPaths: string[]): RepoDataState {
  return createInitialRepoData(openPaths);
}
