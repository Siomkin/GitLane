// The repo store's non-write actions: opening and closing repositories, tabs
// and recents, refreshing, selection and the file-history/compare routes, the
// file browser, conflicts, and remotes.

import type {
  HistorySearchPage,
  HistorySearchQuery,
  RemoteInfo,
} from "@/lib/api";
import {
  ChangeSource,
  CompareScope,
} from "./views";

export interface RepoActions {
  /** Open a repo through the native folder picker. Resolves to the picked path,
   * or null when the dialog was canceled. */
  pickAndOpen: () => Promise<string | null>;
  /** Open the repo at `path`. An already-open path just activates its tab.
   * `replaceTab` switches an existing tab to the new path in place (the
   * in-place worktree switch, GL-110) instead of appending a sibling tab; a
   * genuinely new tab is inserted grouped next to its repository's tabs. */
  loadRepo: (path: string, opts?: { replaceTab?: string }) => Promise<void>;
  closeRepo: (path: string) => Promise<void>;
  /** Reorder the open repository tabs without changing the active repository. */
  reorderOpenPaths: (fromIndex: number, toIndex: number) => void;
  /** Replace the tab order wholesale with `paths` — a permutation of the open
   * set, rejected otherwise. The grouped strip draws tabs in a derived order
   * (group members pulled together), so a drag there resolves to an order, not
   * to a single from/to move. */
  setTabOrder: (paths: string[]) => void;
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
  /** Re-probe which other worktrees hold uncommitted work (the graph's dirty
   * dot), treating the caller as evidence the answer moved — the window
   * regaining focus, after the user was plausibly working in one of them.
   * Ordinary refreshes don't need this: our own commits can't dirty another
   * checkout. Fire-and-forget; see `repoWorktreeDirty.ts`. */
  refreshWorktreeDirty: () => void;
  /** Request the next bounded page of graph history. */
  loadMoreHistory: () => Promise<void>;
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
  /** Keep the working-tree inspector on a live staged/unstaged row. The store
   * owns fallback and bucket changes so components never infer domain state. */
  ensureWorkingFileSelection: () => void;
  selectFile: (path: string, source: ChangeSource) => Promise<void>;
  /** Re-fetch the currently selected file's diff uncapped (the "show full diff"
   * action when a large diff was truncated by the backend line limit). */
  loadFullFileDiff: () => Promise<void>;
  clearSelectedFile: () => void;
  /** Open the combined-diff review for a commit range base..head. */
  compareRange: (base: string, head: string, title: string) => void;
  /** Open a dedicated history-inspection page for a repo-relative file. */
  openFileHistory: (path: string, mode?: "history" | "blame") => Promise<void>;
  /** Switch the open file-history route between history and blame. Supplying a
   * revision/path opens blame at that exact historical file identity. */
  setFileHistoryMode: (
    mode: "history" | "blame",
    revision?: string | null,
    path?: string | null,
  ) => void;
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
  /** Save the draft with its exact-state lease; keeps edit mode open. */
  saveFileEdit: () => Promise<void>;
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
