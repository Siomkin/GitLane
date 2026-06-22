import { invoke } from "@tauri-apps/api/core";
import type { GithubAccountRef } from "./github";

export type RefKind = "branch" | "remote" | "tag" | "head";

export interface RefLabel {
  name: string;
  kind: RefKind;
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
}

export interface GraphEdge {
  fromRow: number;
  fromLane: number;
  toRow: number;
  toLane: number;
  color: number;
}

export interface RepoGraph {
  commits: CommitNode[];
  edges: GraphEdge[];
  laneCount: number;
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

export interface BranchInfo {
  name: string;
  kind: "local" | "remote";
  target: string | null;
  isHead: boolean;
  upstream: string | null;
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

  // ---- working tree / staging ----

  workingChanges: (path: string) =>
    invoke<WorkingChanges>("working_changes", { path }),

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
