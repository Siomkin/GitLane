import { invoke } from "@tauri-apps/api/core";
import type { GithubAccountRef } from "./github";

export type RefKind = "branch" | "remote" | "tag" | "head";

export interface RefLabel {
  name: string;
  kind: RefKind;
}

/** Marks a graph node that is an in-window stash rather than a commit (see the
 * Rust `StashRef`). The node's single parent is the stash base; the frontend
 * paints it as the amber `stash@{index}` marker with a dashed edge to the base. */
export interface StashRef {
  index: number;
  message: string;
}

export interface CommitNode {
  id: string;
  shortId: string;
  summary: string;
  body: string;
  authorName: string;
  authorEmail: string;
  timestamp: number; // unix seconds
  parents: string[];
  lane: number;
  row: number;
  color: number;
  refs: RefLabel[];
  /** Present (and non-null) only when this node is an injected in-window stash. */
  stash?: StashRef | null;
}

export interface GraphEdge {
  fromRow: number;
  fromLane: number;
  toRow: number;
  toLane: number;
  /** Zero-based parent index on the child commit; > 0 means merge parent. */
  parentIndex?: number;
  color: number;
}

export interface RepoGraph {
  commits: CommitNode[];
  edges: GraphEdge[];
  laneCount: number;
  /** Synthetic WIP marker lane, when the backend resolves one separately from HEAD. */
  wipLane?: number | null;
  wipColor?: number | null;
  head: string | null;
  truncated: boolean;
}

export interface RepoSummary {
  path: string;
  workdir: string | null;
  headBranch: string | null;
  headOid: string | null;
  detached: boolean;
}

/** Commit identity (name + email) pinned for a repo. */
export interface RepoIdentity {
  name: string;
  email: string;
}

/** Remote forge keys emitted by the backend's `ForgeKind::key()`
 * (`src-tauri/src/git/forge.rs`). This is the single source of truth on the TS
 * side — compare against `ForgeKind.GitHub` rather than a bare `"github"`
 * literal, so a typo fails to compile and a rename is one edit. Keep in sync
 * with the Rust enum across the IPC boundary. */
export const ForgeKind = {
  GitHub: "github",
  GitLab: "gitlab",
  Bitbucket: "bitbucket",
  AzureDevOps: "azure-devops",
  Gitea: "gitea",
  Forgejo: "forgejo",
} as const;
export type ForgeKind = (typeof ForgeKind)[keyof typeof ForgeKind];

/** Remote-forge summary driving the toolbar provider indicator. */
export interface RepoForge {
  /** True when the repo has at least one remote with a URL. */
  hasRemote: boolean;
  /** Forge key (see {@link ForgeKind}), or null when the host is unrecognised. */
  kind: ForgeKind | null;
  /** Human forge label ("GitHub", "GitLab", …), or null when unrecognised. */
  forge: string | null;
  /** Remote host (e.g. "github.com"), or null when no remote is configured. */
  host: string | null;
  /** Browser URL for the repo (`https://host/owner/repo`), or null when none. */
  webUrl: string | null;
}

export interface BranchInfo {
  name: string;
  kind: "local" | "remote";
  target: string | null;
  isHead: boolean;
  upstream: string | null;
  sync?: BranchSyncState | null;
}

export type BranchSyncStatus =
  | "noRemote"
  | "noUpstream"
  | "staleUpstream"
  | "unknown"
  | "upToDate"
  | "ahead"
  | "behind"
  | "diverged";

export interface BranchSyncState {
  status: BranchSyncStatus;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface ReflogEntry {
  oid: string;
  shortOid: string;
  selector: string;
  shortSelector: string;
  refName: string;
  subject: string;
  committerName: string;
  committerEmail: string;
  timestamp: number;
}

export interface DestructivePreview {
  summary: string;
  details: string[];
  warnings: string[];
}

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string | null;
  isMain: boolean;
}

export interface StashEntry {
  index: number;
  message: string;
  oid: string;
  /** Committer time of the stash commit itself — used to slot the stash into the
   * date-ordered history where it was created (date-ordered placement). */
  timestamp: number;
  baseOid: string | null;
  baseTimestamp: number | null;
  context: StashContextCommit[];
}

export interface StashContextCommit {
  id: string;
  shortId: string;
  summary: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  parents: string[];
}

/** One-letter git status code emitted by the Rust layer (status.rs). */
export type FileStatus = "M" | "A" | "D" | "R" | "C" | "T" | "U";

export interface FileChange {
  path: string;
  status: FileStatus;
  add: number;
  del: number;
}

export interface WorkingChanges {
  staged: FileChange[];
  unstaged: FileChange[];
  /** Unmerged (conflicted) paths, kept out of staged/unstaged so the ordinary
   * stage view can't apply normal staging to a file git considers unresolved —
   * surfaced separately so they stay visible even when the owning operation
   * isn't detected. */
  conflicted: FileChange[];
}

/** The active in-progress operation that can stop on conflicts. "none" when the
 * repo is clean / no operation is underway. */
export type OperationKind = "merge" | "rebase" | "cherry-pick" | "revert" | "none";

/** One conflicted (unmerged) path. */
export interface ConflictFile {
  path: string;
  /** "text" (line-mergeable), "binary", or "deleted" (one side removed it). */
  kind: "text" | "binary" | "deleted";
  /** For "deleted", the side that removed the file ("ours" | "theirs"); else "". */
  deletedSide: "ours" | "theirs" | "";
}

/** The in-progress operation + its outstanding conflicts (see Rust
 * `git::conflicts::operation_status`). */
export interface OperationStatus {
  kind: OperationKind;
  /** True when the operation supports skipping the current commit. */
  canSkip: boolean;
  conflicts: ConflictFile[];
}

/** Raw conflicted content of one text file (with git's merge markers). */
export interface ConflictFileContent {
  path: string;
  content: string;
  binary: boolean;
}

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  oldNo: number | null;
  newNo: number | null;
  content: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  status: FileStatus;
  add: number;
  del: number;
  binary: boolean;
  hunks: DiffHunk[];
  /** True when the backend capped the diff at the line limit; the UI offers a
   * "show full diff" that re-fetches with `full: true`. */
  truncated: boolean;
}

export const gitApi = {
  openRepo: (path: string) => invoke<RepoSummary>("open_repo", { path }),

  /** Detect the open repo's remote forge for the toolbar provider indicator. */
  repoForge: (path: string) => invoke<RepoForge>("repo_forge", { path }),

  commitGraph: (path: string, limit?: number) =>
    invoke<RepoGraph>("commit_graph", { path, limit: limit ?? null }),

  listBranches: (path: string) =>
    invoke<BranchInfo[]>("list_branches", { path }),

  listWorktrees: (path: string) =>
    invoke<WorktreeInfo[]>("list_worktrees", { path }),

  /** Create a linked worktree at `worktreePath`, checked out to `reference`
   * (branch/tag/commit; defaults to HEAD). */
  addWorktree: (path: string, worktreePath: string, reference?: string) =>
    invoke<string>("add_worktree", { path, worktreePath, reference: reference ?? null }),

  checkout: (path: string, target: string) =>
    invoke<string>("checkout", { path, target }),

  createBranch: (path: string, name: string, startPoint?: string) =>
    invoke<string>("create_branch", { path, name, startPoint: startPoint ?? null }),

  deleteBranch: (path: string, name: string, force = false) =>
    invoke<string>("delete_branch", { path, name, force }),

  listReflog: (path: string, limit?: number) =>
    invoke<ReflogEntry[]>("list_reflog", { path, limit: limit ?? null }),

  previewReset: (
    path: string,
    target: string,
    mode: "soft" | "mixed" | "hard",
    // The ref being reset; omit for current-branch resets (defaults to HEAD).
    source?: string,
  ) => invoke<DestructivePreview>("preview_reset", { path, target, mode, source: source ?? null }),

  previewDiscardAll: (path: string) =>
    invoke<DestructivePreview>("preview_discard_all", { path }),

  previewDeleteBranch: (path: string, branch: string) =>
    invoke<DestructivePreview>("preview_delete_branch", { path, branch }),

  previewDeleteRemoteBranch: (path: string, remote: string, branch: string) =>
    invoke<DestructivePreview>("preview_delete_remote_branch", { path, remote, branch }),

  previewForcePush: (path: string, branch: string) =>
    invoke<DestructivePreview>("preview_force_push", { path, branch }),

  renameBranch: (path: string, oldName: string, newName: string) =>
    invoke<string>("rename_branch", { path, old: oldName, new: newName }),

  /** Point `branch`'s upstream at the remote-tracking ref `upstream` (e.g.
   * "origin/main"). The ref must already exist. */
  setUpstream: (path: string, branch: string, upstream: string) =>
    invoke<string>("set_upstream", { path, branch, upstream }),

  mergeBranch: (path: string, branch: string) =>
    invoke<string>("merge_branch", { path, branch }),

  /** True when `to` can be fast-forwarded to `from` (from is a descendant of to). */
  canFastForward: (path: string, from: string, to: string) =>
    invoke<boolean>("can_fast_forward", { path, from, to }),

  /** Fast-forward the current branch to `target` (fails if not a fast-forward). */
  fastForward: (path: string, target: string) =>
    invoke<string>("fast_forward", { path, target }),

  /** Fast-forward a non-checked-out `branch` to `target` in place, without
   * switching the working tree (fails if not a fast-forward). */
  fastForwardBranch: (path: string, branch: string, target: string) =>
    invoke<string>("fast_forward_branch", { path, branch, target }),

  rebaseOnto: (path: string, onto: string) =>
    invoke<string>("rebase_onto", { path, onto }),

  resetTo: (path: string, target: string, mode: "soft" | "mixed" | "hard") =>
    invoke<string>("reset_to", { path, target, mode }),

  cherryPick: (path: string, commit: string) =>
    invoke<string>("cherry_pick", { path, commit }),

  /** Cherry-pick several commits in one atomic `git cherry-pick A B C…`. */
  cherryPickMany: (path: string, commits: string[]) =>
    invoke<string>("cherry_pick_many", { path, commits }),

  revertCommit: (path: string, commit: string) =>
    invoke<string>("revert_commit", { path, commit }),

  /** Revert several commits in one atomic `git revert --no-edit A B…`. */
  revertMany: (path: string, commits: string[]) =>
    invoke<string>("revert_many", { path, commits }),

  // ---- conflict resolution ----

  /** The active merge/rebase/cherry-pick/revert operation + its conflicts. */
  operationStatus: (path: string) =>
    invoke<OperationStatus>("operation_status", { path }),

  /** Worktree copy of a conflicted text file (with `<<<<<<< ======= >>>>>>>`
   * markers) for the in-app editor to parse. */
  conflictFile: (path: string, file: string) =>
    invoke<ConflictFileContent>("conflict_file", { path, file }),

  /** Resolve a conflicted file by taking one whole side (`git checkout
   * --ours/--theirs` + stage; removes the file when that side deleted it). */
  acceptConflictSide: (path: string, file: string, side: "ours" | "theirs") =>
    invoke<string>("accept_conflict_side", { path, file, side }),

  /** Write merged `content` to a conflicted file and stage it (the hunk editor's
   * reconstructed result). */
  resolveConflictFile: (path: string, file: string, content: string) =>
    invoke<string>("resolve_conflict_file", { path, file, content }),

  /** Stage a conflicted file as-is (mark resolved after a manual edit). */
  markConflictResolved: (path: string, file: string) =>
    invoke<string>("mark_conflict_resolved", { path, file }),

  /** Restore conflict markers for an already-resolved file (`git checkout
   * --merge`) so it can be re-resolved. */
  reconflictFile: (path: string, file: string) =>
    invoke<string>("reconflict_file", { path, file }),

  /** Continue the active operation after staging resolutions. `name`/`email`
   * pin the bound identity onto the resulting commit (as `commit` does). */
  continueOperation: (
    path: string,
    kind: OperationKind,
    name?: string | null,
    email?: string | null,
  ) =>
    invoke<string>("continue_operation", {
      path,
      kind,
      name: name ?? null,
      email: email ?? null,
    }),

  /** Abort the active operation, restoring the pre-operation state. */
  abortOperation: (path: string, kind: OperationKind) =>
    invoke<string>("abort_operation", { path, kind }),

  /** Skip the current commit in a sequencer operation (rebase/cherry-pick/revert). */
  skipOperation: (path: string, kind: OperationKind) =>
    invoke<string>("skip_operation", { path, kind }),

  /** Create a lightweight tag at `sha` (or HEAD when omitted). */
  createTag: (path: string, name: string, sha?: string) =>
    invoke<string>("create_tag", { path, name, sha: sha ?? null }),

  /** Create an annotated tag (tagger + `message`) at `sha` (or HEAD). */
  createAnnotatedTag: (path: string, name: string, message: string, sha?: string) =>
    invoke<string>("create_annotated_tag", { path, name, message, sha: sha ?? null }),

  /** Write a `.patch` file for the single commit `sha` into the worktree
   * (`git format-patch -1`); resolves with the created filename. */
  createPatch: (path: string, sha: string) =>
    invoke<string>("create_patch", { path, sha }),

  /** Delete a local tag. */
  deleteTag: (path: string, name: string) =>
    invoke<string>("delete_tag", { path, name }),

  /** Push a tag to `origin`, optionally as the repo's bound `account`. */
  pushTag: (path: string, name: string, account?: GithubAccountRef | null) =>
    invoke<string>("push_tag", { path, name, account: account ?? null }),

  /** Remove a linked worktree. `force` drops git's dirty/locked safety check. */
  removeWorktree: (path: string, worktreePath: string, force = false) =>
    invoke<string>("remove_worktree", { path, worktreePath, force }),

  /** Delete `branch` on `remote` (`git push <remote> --delete`), optionally as
   * the repo's bound `account`. `branch` is the short name (no `remote/` prefix). */
  deleteRemoteBranch: (
    path: string,
    remote: string,
    branch: string,
    account?: GithubAccountRef | null,
  ) => invoke<string>("delete_remote_branch", { path, remote, branch, account: account ?? null }),

  /** Force-push a specific `branch` with `--force-with-lease` (targets only that
   * branch, never the whole push.default set), optionally as the bound `account`. */
  forcePush: (path: string, branch: string, account?: GithubAccountRef | null) =>
    invoke<string>("force_push", { path, branch, account: account ?? null }),

  /** Discard every uncommitted change: reset tracked files to HEAD and remove
   * untracked files/dirs. Irreversible. */
  discardAll: (path: string) => invoke<string>("discard_all", { path }),

  // ---- working tree / staging ----

  workingChanges: async (path: string): Promise<WorkingChanges> => {
    const r = await invoke<WorkingChanges>("working_changes", { path });
    // The backend always sends `conflicted`, but normalize defensively so every
    // consumer can rely on the field being present (a defensive `?? []` once,
    // here, instead of scattered across every reader).
    return { ...r, conflicted: r.conflicted ?? [] };
  },

  /** Diff for a working-tree file. `staged` true → index vs HEAD; false → worktree vs index.
   * `full` bypasses the backend line cap (for an explicit "show full diff"). */
  fileDiff: (path: string, file: string, staged: boolean, full?: boolean) =>
    invoke<FileDiff>("file_diff", { path, file, staged, full: full ?? null }),

  /** Changed files in a commit (vs its first parent). */
  commitFiles: (path: string, oid: string) =>
    invoke<FileChange[]>("commit_files", { path, oid }),

  /** Diff for one file within a commit (vs its first parent). `full` bypasses
   * the backend line cap (for an explicit "show full diff"). */
  commitFileDiff: (path: string, oid: string, file: string, full?: boolean) =>
    invoke<FileDiff>("commit_file_diff", { path, oid, file, full: full ?? null }),

  /** Changed files across a range base..head (either side accepts any
   * commit-ish: a SHA, "HEAD", a branch). */
  diffRange: (path: string, base: string, head: string) =>
    invoke<FileChange[]>("diff_range", { path, base, head }),

  /** Diff for one file across a range base..head. `full` bypasses the backend
   * line cap (for an explicit "show full diff"). */
  diffRangeFile: (path: string, base: string, head: string, file: string, full?: boolean) =>
    invoke<FileDiff>("diff_range_file", { path, base, head, file, full: full ?? null }),

  stageFile: (path: string, file: string) =>
    invoke<string>("stage_file", { path, file }),

  unstageFile: (path: string, file: string) =>
    invoke<string>("unstage_file", { path, file }),

  /** Stage one hunk from an unstaged diff, or unstage one hunk from a staged diff. */
  applyHunk: (path: string, file: string, staged: boolean, hunkIndex: number, expectedHeader: string) =>
    invoke<string>("apply_hunk", { path, file, staged, hunkIndex, expectedHeader }),

  /** Stage one changed line from an unstaged diff, or unstage one changed line from a staged diff. */
  applyLine: (
    path: string,
    file: string,
    staged: boolean,
    hunkIndex: number,
    lineIndex: number,
    line: DiffLine,
  ) =>
    invoke<string>("apply_line", {
      path,
      file,
      staged,
      hunkIndex,
      lineIndex,
      expectedKind: line.kind,
      expectedContent: line.content,
      expectedOldNo: line.oldNo,
      expectedNewNo: line.newNo,
    }),

  /** Unstage several files atomically (one `git restore --staged`). */
  unstageFiles: (path: string, files: string[]) =>
    invoke<string>("unstage_files", { path, files }),

  /** Discard a file's working-tree changes (reverting to HEAD). When `staged`,
   * the file is unstaged first; an untracked file is removed. */
  discardFile: (path: string, file: string, staged: boolean) =>
    invoke<string>("discard_file", { path, file, staged }),

  stageAll: (path: string) => invoke<string>("stage_all", { path }),

  unstageAll: (path: string) => invoke<string>("unstage_all", { path }),

  /** Create a commit. When `authorName`/`authorEmail` are given they are pinned
   * as both author and committer for this commit (see write.rs::commit). */
  commit: (
    path: string,
    summary: string,
    description: string,
    amend: boolean,
    authorName?: string | null,
    authorEmail?: string | null,
  ) =>
    invoke<string>("commit", {
      path,
      summary,
      description,
      amend,
      name: authorName ?? null,
      email: authorEmail ?? null,
    }),

  stash: (path: string) => invoke<string>("stash", { path }),

  listStashes: (path: string) => invoke<StashEntry[]>("list_stashes", { path }),

  stashApply: (path: string, index: number) => invoke<string>("stash_apply", { path, index }),

  /** Apply a stash restoring the staged (index) state too (`git stash apply --index`). */
  stashApplyIndex: (path: string, index: number) => invoke<string>("stash_apply_index", { path, index }),

  /** Check out `branch` at the stash's parent and apply the stash there. */
  stashBranch: (path: string, branch: string, index: number) => invoke<string>("stash_branch", { path, branch, index }),

  stashPop: (path: string, index: number) => invoke<string>("stash_pop", { path, index }),

  stashDrop: (path: string, index: number) => invoke<string>("stash_drop", { path, index }),

  pull: (path: string) => invoke<string>("pull", { path }),

  /** Fetch + prune all remotes, optionally as the repo's bound `account`. */
  fetch: (path: string, account?: GithubAccountRef | null) =>
    invoke<string>("fetch", { path, account: account ?? null }),

  /** Push, optionally as the repo's bound `account` (gh username). */
  push: (path: string, account?: GithubAccountRef | null) =>
    invoke<string>("push", { path, account: account ?? null }),

  /** Push a specific (possibly not-checked-out) `branch` to its configured
   * remote (origin fallback), optionally as the repo's bound `account`. */
  pushBranch: (path: string, branch: string, account?: GithubAccountRef | null) =>
    invoke<string>("push_branch", { path, branch, account: account ?? null }),

  /** First-push flow: create/update `upstream` (`remote/branch`) and set it as
   * `branch`'s upstream in the same git push. */
  publishBranch: (path: string, branch: string, upstream: string, account?: GithubAccountRef | null) =>
    invoke<string>("publish_branch", { path, branch, upstream, account: account ?? null }),
  /** Write the bound account's identity into the repo's local git config. */
  setRepoIdentity: (path: string, name: string, email: string) =>
    invoke<string>("set_repo_identity", { path, name, email }),

  /** Read the identity pinned in the repo's local git config (the durable,
   * build-independent source of truth). `null` = nothing pinned locally. */
  repoIdentity: (path: string) => invoke<RepoIdentity | null>("repo_identity", { path }),

  /** Remove the pinned identity from local git config (defer to global). */
  clearRepoIdentity: (path: string) => invoke<string>("clear_repo_identity", { path }),
  /** Start watching `path`; the backend emits `repo-changed` on any change. */
  watchRepo: (path: string) => invoke<void>("watch_repo", { path }),
};
