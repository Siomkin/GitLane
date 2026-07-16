import type { StoreApi } from "zustand";
import type {
  BranchInfo,
  DestructivePreview,
  FileBlame,
  ConflictFile,
  DiffLine,
  FileChange,
  FileDiff,
  FileHistoryEntry,
  HistorySearchPage,
  HistorySearchQuery,
  OperationAdvisory,
  OperationKind,
  ReflogEntry,
  RemoteInfo,
  RepoFileContent,
  RepoForge,
  RepoGraph,
  RepoSummary,
  StashEntry,
  WorkingChanges,
  WorktreeInfo,
} from "@/lib/api";
import type { RecentRepo } from "./repoSession";
import type { TabInfo } from "@/lib/tabs";
import { emptyAdvancedState } from "@/lib/advancedRepoState";

export type ChangeSource = "unstaged" | "staged" | "commit";

/** Startup restoration has its own phase so the no-repository onboarding is
 * only shown after the persisted session has genuinely resolved. */
export const SESSION_RESTORE_PHASE = {
  Pending: "pending",
  Restoring: "restoring",
  Complete: "complete",
} as const;
export type SessionRestorePhase =
  (typeof SESSION_RESTORE_PHASE)[keyof typeof SESSION_RESTORE_PHASE];

/** Decide whether startup has persisted repository state to reconcile. Open
 * tabs count even without a last-active path so partial/corrupt storage still
 * gets its GL-109 tab probe before onboarding is shown. */
export function initialSessionRestorePhase(
  openPaths: string[],
  lastPath: string | null,
): SessionRestorePhase {
  return lastPath || openPaths.length > 0
    ? SESSION_RESTORE_PHASE.Pending
    : SESSION_RESTORE_PHASE.Complete;
}

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

/** The repository file listing shown in the right panel's Files tab. Null until
 * the tab first loads it; kept fresh by `refresh` while present. */
export interface RepoFilesState {
  /** Repo-relative paths, sorted (tracked + untracked, ignored excluded). */
  files: string[];
  loading: boolean;
  error: string | null;
}

/** In-app edit session for the open file (GL-212). Present only while editing.
 * Dirtiness is derived (`draft !== content.text`) rather than stored, so a save
 * that republishes `content.text` clears it with no extra bookkeeping. */
export interface FileEditState {
  /** The editable buffer, seeded from `content.text` on entry. */
  draft: string;
  /** Byte size the draft was baselined from — passed to `write_repo_file` as the
   * on-disk size guard, and advanced to the new size after each save. */
  baseSize: number;
  /** True while a save is in flight. */
  saving: boolean;
  /** Last save failure to surface (cleared on the next edit/save). */
  error: string | null;
}

/** A repository file opened in the center pane (from the Files tab). Read-only
 * by default (GL-211); `edit` is set once the user starts editing (GL-212). */
export interface FileViewState {
  /** Repo-relative path of the opened file. */
  path: string;
  content: RepoFileContent | null;
  loading: boolean;
  error: string | null;
  /** The active edit session, or null/absent when viewing read-only. */
  edit?: FileEditState | null;
  /** Committed (HEAD) text, the baseline for the uncommitted-change gutter
   * markers. `null` when there's nothing to diff against (untracked, binary,
   * oversized, or unborn HEAD); absent on fixtures that predate the field. */
  baseline?: string | null;
}

/** The merged ("union") diff of a multi-commit selection (GL-68/GL-69). Present
 * only while more than one commit is selected. `files` is the union of changes
 * across the whole selection — the net change per file — for any selection,
 * contiguous or not (the backend `selection_diff` composes it). */
export interface SelectionDiffState {
  /** Selected commit ids (selection order — graph slice for a shift-range, click
   * order for additive); the union source. The backend re-orders by ancestry
   * (then committer time for unrelated commits), so the order stored here doesn't
   * affect the merged result. */
  commits: string[];
  /** Union of files changed across the selection (net status + counts). */
  files: FileChange[];
  loading: boolean;
  error: string | null;
}

/** The dedicated missing-repo tab state (GL-108). Set when opening a tab whose
 * path no longer resolves — the workspace swaps to a recovery screen offering
 * Remove / Locate… / Retry instead of the raw open error on the global bar. */
export interface MissingRepoState {
  path: string;
  /** `missing` = the path is gone (moved, deleted, or unmounted volume);
   * `notARepository` = the folder exists but lost its `.git`. */
  kind: "missing" | "notARepository";
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
  /** Monotonic identity of explicit file-selection requests. Unlike
   * `selectedFile`, this changes when the user re-selects the active file so
   * virtual review surfaces can repeat navigation to its offscreen header. */
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

  pickAndOpen: () => Promise<void>;
  /** Open the repo at `path`. An already-open path just activates its tab.
   * `replaceTab` switches an existing tab to the new path in place (the
   * in-place worktree switch, GL-110) instead of appending a sibling tab; a
   * genuinely new tab is inserted grouped next to its repository's tabs. */
  loadRepo: (path: string, opts?: { replaceTab?: string }) => Promise<void>;
  closeRepo: (path: string) => Promise<void>;
  /** Reorder the open repository tabs without changing the active repository. */
  reorderOpenPaths: (fromIndex: number, toIndex: number) => void;
  restoreSession: () => Promise<void>;
  /** Re-probe one open tab's identity info (branch, worktree parent) so its
   * label stays live while the tab is in the background (GL-116). The full
   * data reload still happens on activation via `loadRepo`. */
  refreshTabInfo: (path: string) => Promise<void>;
  /** Refresh recents' presence + current branch from disk (start-screen mount):
   * flags paths that no longer exist as `missing` and updates their branch. */
  refreshRecents: () => Promise<void>;
  /** Drop one recent entry (e.g. a missing path the user dismisses). */
  removeRecent: (path: string) => void;
  /** Locate… for a dead repository path (GL-108): folder picker → carry the
   * stale path's per-repo bindings to the picked repo → replace the stale tab
   * and recents entry → open it. A non-repo pick leaves everything in place
   * (toast). Defaults to the missing-repo tab state; the onboarding "Recent"
   * list passes its stale path explicitly. */
  locateMissingRepo: (fromPath?: string) => Promise<void>;
  /** True while [`initMissingRepo`] is in flight — disables the button so a
   * double-click can't fire two inits. */
  initMissingRepoRunning: boolean;
  /** Initialize as git repo… (GL-153): for the missing-repo tab's
   * `notARepository` case (the folder exists but lost its `.git`), run a
   * plain `git init` in place — no README/.gitignore scaffolding, the
   * existing files are left untouched — then open it. Other failures surface
   * as a toast; if the folder became a repo again concurrently, Retry is
   * attempted automatically. */
  initMissingRepo: () => Promise<void>;
  /** Clear the entire recent list. */
  clearRecents: () => void;
  /** Re-read repo state from disk. `scope: "worktree"` updates only working
   * changes, avoiding a graph rebuild for ordinary file/index watcher events.
   * Never rejects — errors are recorded in store state — but resolves `true`
   * only when it actually published fresh data for the repo it started on;
   * `false` when it was deferred, superseded, or failed, so callers (the fetch
   * toast) can tell whether post-refresh reads are trustworthy. */
  refresh: (opts?: {
    prs?: boolean;
    quiet?: boolean;
    scope?: "all" | "worktree";
  }) => Promise<boolean>;
  /** Request the next bounded page of graph history. */
  loadMoreHistory: () => Promise<void>;
  /** Poll and consume a commit-message draft handed back by a terminal agent. */
  takeAgentCommitDraft: (repoPath: string, token: string) => Promise<string | null>;
  /** Poll and consume an inline working-change summary from a terminal agent. */
  takeAgentChangeSummary: (repoPath: string, token: string) => Promise<string | null>;
  /** Search every commit reachable from repository refs without expanding the
   * bounded graph first. The caller owns transient query/result UI state. */
  searchHistory: (query: HistorySearchQuery) => Promise<HistorySearchPage>;
  /** HEAD-tree paths containing `filter` — the advanced search's File-path
   * autosuggest. Best-effort: no repo (or a read failure) suggests nothing. */
  suggestTreePaths: (filter: string) => Promise<string[]>;
  loadReflog: () => Promise<void>;
  selectCommit: (id: string | null) => Promise<void>;
  /** Select `id`, surface the graph, and request a scroll to it. Used by the
   * branch navigator so picking a branch jumps the graph to that branch's tip. */
  revealCommit: (id: string) => Promise<void>;
  /** Select the history tab and scroll to a synthetic stash row without
   * selecting the stash's file list in the inspector. */
  revealStash: (oid: string) => void;
  /** The complete route transition back to the history graph: closes every
   * view that outranks it in `deriveCenterView` (comparison, file history,
   * stacked review, a committed file's review) and selects the history tab.
   * `setLeftTab("history")` alone can't leave those routes — they take
   * priority over the tab — so navigator reveals and the center error
   * fallback's "Back to graph" go through here. */
  returnToGraph: () => void;
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
  /** Checkout local `branch` for `remote/branch`, creating it with tracking or
   * safely fast-forwarding it when it already exists. */
  checkoutRemoteBranch: (remote: string, branch: string) => Promise<string>;
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
  /** Rebase the explicit source branch/revision onto the target. */
  rebaseOnto: (source: string, onto: string) => Promise<string>;
  /** Reset the explicit source branch, or detached HEAD when source is null. */
  resetBranchTo: (
    source: string | null,
    target: string,
    mode: "soft" | "mixed" | "hard",
  ) => Promise<string>;
  /** Stash actions address the stash by commit oid — `stash@{n}` indices go
   * stale whenever any stash is created/dropped, even in another worktree. */
  applyStash: (oid: string, pop: boolean, withIndex?: boolean) => Promise<string>;
  /** Check out `branch` at the stash's parent and apply the stash there. */
  branchFromStash: (oid: string, branch: string) => Promise<string>;
  dropStash: (oid: string) => Promise<string>;
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
  /** Delete a local tag. A copy still on origin is re-imported by fetch —
   * pass `alsoRemote` to delete it from origin in the same operation. */
  deleteTag: (name: string, alsoRemote?: boolean) => Promise<string>;
  /** Push a tag to `remote` (the default push remote when omitted). */
  pushTag: (name: string, remote?: string) => Promise<string>;
  /** Remove a linked worktree (`force` drops the dirty/locked check). */
  removeWorktree: (worktreePath: string, force?: boolean) => Promise<string>;
  /** Hand a branch off from one worktree to another (GL-74): detach the source,
   * check the branch out in `toWorktreePath`, and — when `carry` — bring the
   * source's uncommitted work along. Lands the app on the destination; a
   * conflicting carry opens the conflict workspace there. */
  moveBranchToWorktree: (
    branch: string,
    fromWorktreePath: string,
    toWorktreePath: string,
    carry: boolean,
  ) => Promise<string>;
  /** Preview deleting `branch` (unmerged-commit warning + recovery note) for the
   * delete-branch-and-worktree dialog's configure screen. A read-shaped preview,
   * so it does not refresh. */
  previewDeleteBranch: (branch: string) => Promise<DestructivePreview>;
  /** Remove the linked worktree holding `branch`, then delete the branch — the
   * one-step path when a branch's Delete is locked by its worktree. `repoPath` is
   * explicit (not read from the live summary) so the op stays pinned to the repo
   * the dialog started on across a mid-run switch. Does NOT refresh: the GL-107
   * dialog drives the graph refresh itself so it can surface it as the checklist's
   * "Refreshing" row (see useDeleteWorktreeRun). */
  deleteBranchWithWorktree: (
    branch: string,
    fromWorktreePath: string,
    repoPath: string,
  ) => Promise<string>;
  /** Delete a branch on its remote. `remote`/`branch` are split from the
   * remote-tracking ref name (e.g. `origin/feature` → `origin`, `feature`). */
  deleteRemoteBranch: (remote: string, branch: string) => Promise<string>;
  /** Force-push `branch` with `--force-with-lease` (only that branch). */
  forcePush: (branch: string) => Promise<string>;
  /** Discard every uncommitted working-tree change (reset --hard + clean). */
  discardAll: () => Promise<string>;
  /** Write a `.patch` file for one commit into the worktree. */
  createPatchAt: (sha: string) => Promise<string>;
  /** Create a worktree at `worktreePath`, then open it as a repo tab. With
   * `newBranch`, a fresh branch of that name is created at `reference` (its
   * start point) and checked out in the worktree; otherwise the worktree is
   * checked out to `reference` directly. */
  createWorktreeAt: (
    worktreePath: string,
    reference: string,
    newBranch?: string,
  ) => Promise<string>;
  /** Switch the app to an existing worktree. By default the current tab's
   * path switches in place — one repository, one tab (GL-110); `newTab` is the
   * explicit side-by-side action, opening a separate worktree-styled tab
   * grouped next to this repository's tabs. */
  openWorktree: (worktreePath: string, opts?: { newTab?: boolean }) => Promise<void>;
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
  /** Load (or reload) the Files-tab repository listing. */
  loadRepoFiles: () => Promise<void>;
  /** Open a repository file read-only in the center pane (Files tab click). */
  openRepoFile: (path: string) => Promise<void>;
  /** Open a repository file, first confirming discard if the current viewer has
   * unsaved edits. The entry point every file-open affordance should use. */
  requestOpenRepoFile: (path: string) => void;
  /** Silently re-read the open file's content (watcher/checkout refresh) — keeps
   * the current text visible until the new content lands; closes the viewer if
   * the file is gone (e.g. it doesn't exist on the newly checked-out branch). */
  reloadFileView: () => Promise<void>;
  closeRepoFile: () => void;
  /** Enter in-app edit mode for the open file (seeds the draft from the current
   * text). No-op unless the file is editable (present, text, not binary, not
   * truncated). */
  beginFileEdit: () => void;
  /** Update the editable draft as the user types. */
  updateFileDraft: (text: string) => void;
  /** Discard edits, resetting the draft to the last-saved text (stays in edit mode). */
  revertFileEdit: () => void;
  /** Leave edit mode (discarding any draft). Callers guard unsaved changes. */
  endFileEdit: () => void;
  /** Save the draft to disk (`write_repo_file`); keeps edit mode open. */
  saveFileEdit: () => Promise<void>;
  checkoutDetached: (sha: string) => Promise<string>;
  stageFile: (path: string) => Promise<void>;
  unstageFile: (path: string) => Promise<void>;
  /** Stage every file under a directory at once (Tree-view folder roll-up). */
  stagePaths: (paths: string[]) => Promise<void>;
  /** Unstage every file under a directory at once (Tree-view folder roll-up). */
  unstagePaths: (paths: string[]) => Promise<void>;
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
  /** Commit the currently staged changes with `message`. Returns whether the
   * commit completed, so the inline composer only clears after success. */
  commitSelected: (message: string, amend?: boolean) => Promise<boolean>;
  stash: () => Promise<void>;
  /** Fetch all remotes. Quiet mode suppresses progress/success notifications
   * for scheduled background runs while preserving the same auth routing.
   * Resolves true when the fetch itself succeeded (even if the follow-up
   * refresh failed), so the auto-fetch scheduler can back off on failures. */
  fetch: (opts?: { quiet?: boolean }) => Promise<boolean>;
  pull: () => Promise<void>;
  push: () => Promise<void>;
  // ---- remotes (Repository settings → Remotes) ----
  /** Reload the open repo's configured remotes into [`remotes`] and re-resolve
   * the per-remote account bindings, returning the fresh list. */
  listRemotes: () => Promise<RemoteInfo[]>;
  /** Add a remote `name` → `url` (`git remote add`). */
  addRemote: (name: string, url: string) => Promise<string>;
  /** Repoint remote `name` at `url` (`git remote set-url`). */
  setRemoteUrl: (name: string, url: string) => Promise<string>;
  /** Remove remote `name` (`git remote remove`). */
  removeRemote: (name: string) => Promise<string>;
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
  | "remotes"
  | "graph"
  | "branches"
  | "reflogEntries"
  | "reflogLoading"
  | "reflogError"
  | "worktrees"
  | "stashes"
  | "openPaths"
  | "sessionRestorePhase"
  | "missingRepo"
  | "initMissingRepoRunning"
  | "tabInfoByPath"
  | "recents"
  | "changes"
  | "operation"
  | "operationAdvisory"
  | "commitFiles"
  | "selectionDiff"
  | "fileHistory"
  | "compare"
  | "repoFiles"
  | "fileView"
  | "selectedFile"
  | "fileSelectionRequestId"
  | "fileDiff"
  | "selectedCommit"
  | "selectedCommits"
  | "selectionAnchor"
  | "wipSelected"
  | "revealTarget"
  | "graphLimit"
  | "loading"
  | "netOps"
  | "fetchingPath"
  | "graphLoading"
  | "loadingMoreHistory"
  | "diffLoading"
  | "error"
>;

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
