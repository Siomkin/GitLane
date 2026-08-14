// The shapes the center/right panes read: what is selected, what a file view
// or file-history route holds, and the compare route's own state. Data only —
// no actions, no store wiring.

import type {
  FileBlame,
  ConflictFile,
  FileChange,
  FileDiff,
  FileHistoryEntry,
  OperationKind,
  RepoFileContent,
} from "@/lib/api";
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
  /** Selected-revision diff failure, separate from history-list failures so a
   * diff retry cannot blank or mislabel a successfully loaded revision list. */
  diffError: string | null;
  blame: FileBlame | null;
  blameLoading: boolean;
  /** Blame-specific error, kept out of [`error`] so a blame failure never
   * blanks the (successfully loaded) history list with a full-page error. */
  blameError: string | null;
  /** The revision the loaded blame is for — independent of [`selectedOid`] so
   * "blame previous revision" can target a parent without moving the list. */
  blameRevision: string | null;
  /** Historical path paired with [`blameRevision`]. Renames can request the
   * same revision through different paths, so revision alone is not identity. */
  blamePath: string | null;
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
  /** Opaque exact-target lease paired with `baseSize`, advanced after each
   * successful save so external edits/replacements are never overwritten. */
  baseExpectedState: string;
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
 * while more than one commit is selected, or while one or more commits are
 * selected together with the uncommitted WIP row (see `workingBase`). `files` is
 * the union of changes across the whole selection — the net change per file —
 * for any selection, contiguous or not (the backend `selection_diff` composes
 * it). */
export interface SelectionDiffState {
  /** Selected commit ids (selection order — graph slice for a shift-range, click
   * order for additive); the union source. The backend re-orders by ancestry
   * (then committer time for unrelated commits), so the order stored here doesn't
   * affect the merged result. */
  commits: string[];
  /** Union of files changed across the selection (net status + counts). */
  files: FileChange[];
  /** Set when the WIP row is part of the selection: the merged diff is then
   * `workingBase` → working tree (index + worktree), so the still-uncommitted
   * work shows alongside the selected commits. Files and per-file diffs come
   * from `compare_refs` instead of `selection_diff`.
   *
   * This side is a **range**, not the union `commits` describes: it covers
   * HEAD's first-parent line down to `workingBase`, including commits between
   * the picks that were never selected (the inspector discloses how many). Only
   * a pick that includes HEAD and sits entirely on that line has such a base —
   * see `workingRange`. Absent/null on a plain committed union. */
  workingBase?: string | null;
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
