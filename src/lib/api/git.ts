import { invoke } from "@tauri-apps/api/core";
import type { GithubAccountRef } from "./github";
import { parse } from "./validate";
import { fileDiffSchema, repoGraphSchema, workingChangesSchema } from "./schemas";

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
  /** True when this checkout is a *linked* worktree. Optional for
   * backward-compatible fixtures; the backend always sends it. */
  isWorktree?: boolean;
  /** The main checkout's path for a linked worktree — the stable repository
   * identity (GL-109/GL-110); null for the main checkout itself. Optional for
   * fixtures; the backend always sends it. */
  mainPath?: string | null;
}

/** The classified rejection of `open_repo` — the one structured IPC error
 * (everything else rejects with a string). Rust distinguishes a moved/deleted
 * path (`missing`) and a folder that lost its `.git` (`notARepository`) from
 * real failures (`other`) so the store can swap in the dedicated missing-repo
 * state instead of the raw libgit2 message (GL-108). */
export interface RepoOpenError {
  kind: "missing" | "notARepository" | "other";
  /** Human-readable message (used for the error bar on `other`). */
  message: string;
  /** The path the open was attempted with. */
  path: string;
}

/** Narrow an `api.openRepo` rejection to the structured {@link RepoOpenError}. */
export function isRepoOpenError(e: unknown): e is RepoOpenError {
  if (!e || typeof e !== "object") return false;
  const err = e as Partial<RepoOpenError>;
  return (
    (err.kind === "missing" || err.kind === "notARepository" || err.kind === "other") &&
    typeof err.message === "string" &&
    typeof err.path === "string"
  );
}

/** Commit identity pinned for a repo: name + email, plus optional signing
 * config. Only the signing *reference* (GPG key id or SSH key path/literal) is
 * ever carried here — never a passphrase or private key. */
export interface RepoIdentity {
  name: string;
  email: string;
  /** `user.signingkey` pinned locally, if any. */
  signingKey?: string;
  /** `gpg.format` — "openpgp" or "ssh". */
  gpgFormat?: string;
  /** `commit.gpgsign` pinned locally, if any. */
  gpgSign?: boolean;
  /** `tag.gpgsign` pinned locally, if any. */
  tagGpgSign?: boolean;
}

/** Optional signing config for {@link api.setRepoIdentity}. Tri-state per field
 * on the Rust side: omitted/`undefined` leaves the local key untouched, an
 * empty string unsets it, a value writes it. */
export interface RepoSigningConfig {
  signingKey?: string;
  gpgFormat?: string;
  gpgSign?: boolean;
  tagGpgSign?: boolean;
}

/** A signing key the user already has, for the profile editor's key picker.
 * Reference only — a GPG key id or SSH public-key path, never private material. */
export interface SigningKey {
  /** Written to `user.signingkey` — a GPG key id or SSH public-key path. */
  value: string;
  /** GPG uid, or SSH key type + comment. */
  label: string;
  format: "openpgp" | "ssh";
}

/** Presence + current branch of a previously-opened repo path (see Rust
 * `RecentStatus`). `exists: false` marks a path that no longer resolves on disk
 * so the onboarding list can flag it "Missing" (and session restore can drop
 * the tab). The tab strip shares this probe for worktree-tab labeling. */
export interface RecentStatus {
  path: string;
  exists: boolean;
  branch: string | null;
  /** True when the path is a *linked* worktree of some repository. Optional
   * for fixtures; the backend always sends it. */
  isWorktree?: boolean;
  /** The main checkout's path when `isWorktree` (see RepoSummary.mainPath).
   * Optional for fixtures; the backend always sends it. */
  mainPath?: string | null;
}

/** Payload of the `clone-progress` event streamed during a clone (see Rust
 * `CloneProgress`). `pct` is the blended overall completion 0–100. */
export interface CloneProgress {
  stage: string;
  pct: number;
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

/** A configured git remote (Repository settings → Remotes). */
export interface RemoteInfo {
  /** Remote name (e.g. "origin"). */
  name: string;
  /** Fetch URL. */
  fetchUrl: string;
  /** Push URL — equals the fetch URL unless a separate push URL is set. */
  pushUrl: string;
  /** True for the repo's default push remote. */
  isDefault: boolean;
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
  /** Bare repository (no working tree) — can't be a handoff destination. Optional
   * for backward-compatible fixtures; the backend always sends it. */
  bare?: boolean;
  /** Prunable — the worktree's directory is gone/stale; not a usable checkout
   * target. Optional for fixtures; the backend always sends it. */
  prunable?: boolean;
  /** Locked (`git worktree lock`) — removal needs `--force --force`. Optional for
   * fixtures; the backend always sends it. */
  locked?: boolean;
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

export interface FileAdvancedState {
  kind: "submodule" | "sparse";
  message: string;
}

export interface FileChange {
  path: string;
  status: FileStatus;
  add: number;
  del: number;
  /** True when git treats the change as binary (no line stats); lets file lists
   * mark it as binary instead of showing a misleading "+0 −0". */
  binary: boolean;
  advanced?: FileAdvancedState;
}

export interface SubmoduleState {
  path: string;
  name: string;
  url?: string | null;
  status: string;
  details: string[];
  dirty: boolean;
  initialized: boolean;
}

export interface LfsState {
  detected: boolean;
  installed: boolean | null;
  issues: string[];
  patterns: string[];
}

export interface SparseCheckoutState {
  enabled: boolean;
  mode: string | null;
  patterns: string[];
  /** True when `patterns` was capped and is a prefix of a longer sparse-checkout
   * file. A non-match against a truncated list is inconclusive (a later, unsent
   * pattern may include the path), so write guards must not block on it. The
   * Rust struct always serializes this; optional only for backward-compatible
   * fixtures that predate the field. */
  truncated?: boolean;
}

export interface AdvancedRepoState {
  submodules: SubmoduleState[];
  lfs: LfsState;
  sparseCheckout: SparseCheckoutState;
}

export interface WorkingChanges {
  staged: FileChange[];
  unstaged: FileChange[];
  /** Unmerged (conflicted) paths, kept out of staged/unstaged so the ordinary
   * stage view can't apply normal staging to a file git considers unresolved —
   * surfaced separately so they stay visible even when the owning operation
   * isn't detected. */
  conflicted: FileChange[];
  advanced?: AdvancedRepoState;
}

/** The active in-progress operation that can stop on conflicts. "none" when the
 * repo is clean / no operation is underway. "carry" is GitLane's worktree-handoff
 * carry (GL-74) — a stash re-apply left conflicts with no git sequencer state. */
export type OperationKind = "merge" | "rebase" | "cherry-pick" | "revert" | "carry" | "none";

/** One conflicted (unmerged) path. */
export interface ConflictFile {
  path: string;
  /** "text" (line-mergeable), "binary", or "deleted" (one side removed it). */
  kind: "text" | "binary" | "deleted";
  /** For "deleted", the side that removed the file — "both" when a DD conflict
   * (e.g. rename/rename) left no side with a version; else "". */
  deletedSide: "ours" | "theirs" | "both" | "";
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
  /** Byte size of the old / new side of a **binary** change, so the UI can show
   * "old → new (±delta)" instead of "+0 −0". Absent when that side doesn't exist
   * (added has no old, deleted no new) or for text diffs. */
  oldSize?: number;
  newSize?: number;
  /** Blob oids for each side of the change, passed to
   * {@link gitApi.readBinaryBlob} to fetch content for a preview (image bytes,
   * markdown source). Absent when the side doesn't exist or libgit2 left no
   * oid. The working-tree side of an unstaged diff is unreliable by oid (zero
   * for binary; a computed hash that need not exist in the ODB for text) —
   * read that side from disk by `path` instead. */
  oldOid?: string;
  newOid?: string;
  /** Owning commit when the diff came from a per-commit patch (`gh pr diff`
   * emits one message per commit): full oid + subject line. Absent for
   * libgit2/status diffs. The PR Diff tab groups same-commit files under one
   * header. */
  commitOid?: string;
  commitSubject?: string;
}

/** Raw bytes of one blob / working-tree file for an inline preview (see Rust
 * `BinaryBlob`). `base64` is absent when the content exceeded the preview cap
 * (then `truncated` is true and only `size` is meaningful). */
export interface BinaryBlob {
  base64?: string;
  size: number;
  truncated: boolean;
}

export interface FileHistoryEntry {
  oid: string;
  shortOid: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  status: FileStatus | "?";
  path: string;
  add: number;
  del: number;
  previousPath: string | null;
}

export interface FileHistoryPage {
  entries: FileHistoryEntry[];
  nextOffset: number;
  hasMore: boolean;
  truncated: boolean;
}

export interface BlameLine {
  lineNo: number;
  content: string;
  oid: string;
  shortOid: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  originalPath: string;
  originalLine: number;
}

export interface FileBlame {
  path: string;
  revision: string | null;
  binary: boolean;
  truncated: boolean;
  lines: BlameLine[];
}

export interface CompareResult {
  files: FileChange[];
  add: number;
  del: number;
  ahead: number;
  behind: number;
}

export const gitApi = {
  openRepo: (path: string) => invoke<RepoSummary>("open_repo", { path }),

  /** Detect the open repo's remote forge for the toolbar provider indicator. */
  repoForge: (path: string) => invoke<RepoForge>("repo_forge", { path }),

  /** List the repo's configured remotes (Repository settings → Remotes). */
  listRemotes: (path: string) => invoke<RemoteInfo[]>("list_remotes", { path }),

  /** Add a new remote `name` → `url` (`git remote add`). */
  addRemote: (path: string, name: string, url: string) =>
    invoke<string>("add_remote", { path, name, url }),

  /** Repoint an existing remote at a new `url` (`git remote set-url`). */
  setRemoteUrl: (path: string, name: string, url: string) =>
    invoke<string>("set_remote_url", { path, name, url }),

  /** Remove a remote (`git remote remove`). */
  removeRemote: (path: string, name: string) =>
    invoke<string>("remove_remote", { path, name }),

  commitGraph: async (path: string, limit?: number): Promise<RepoGraph> =>
    parse(repoGraphSchema, await invoke("commit_graph", { path, limit: limit ?? null }), "commit_graph"),

  listBranches: (path: string) =>
    invoke<BranchInfo[]>("list_branches", { path }),

  listWorktrees: (path: string) =>
    invoke<WorktreeInfo[]>("list_worktrees", { path }),

  /** Create a linked worktree at `worktreePath`, checked out to `reference`
   * (branch/tag/commit; defaults to HEAD). */
  addWorktree: (path: string, worktreePath: string, reference?: string) =>
    invoke<string>("add_worktree", { path, worktreePath, reference: reference ?? null }),

  /** Hand `branch` off from one worktree to another (GL-74): detach the source,
   * check the branch out in `toWorktreePath`, and — when `carry` — bring the
   * source's uncommitted changes along in a stash. The destination's own
   * uncommitted work is preserved across the switch; a conflicting re-apply routes
   * into the conflict workspace as a `"carry"` operation. */
  moveBranchToWorktree: (
    path: string,
    branch: string,
    fromWorktreePath: string,
    toWorktreePath: string,
    carry: boolean,
  ) =>
    invoke<string>("move_branch_to_worktree", {
      path,
      branch,
      fromWorktreePath,
      toWorktreePath,
      carry,
    }),

  /** Remove the linked worktree at `fromWorktreePath`, then delete `branch`. */
  deleteBranchWithWorktree: (path: string, branch: string, fromWorktreePath: string) =>
    invoke<string>("delete_branch_with_worktree", { path, branch, fromWorktreePath }),

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

  /** Delete a local tag. The remote copy (if any) is untouched and fetch will
   * re-import it — use `deleteRemoteTag` to remove it from `origin` too. */
  deleteTag: (path: string, name: string) =>
    invoke<string>("delete_tag", { path, name }),

  /** Delete a tag on `origin` (`git push origin --delete refs/tags/<name>`),
   * optionally as the repo's bound `account`. */
  deleteRemoteTag: (path: string, name: string, account?: GithubAccountRef | null) =>
    invoke<string>("delete_remote_tag", { path, name, account: account ?? null }),

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

  workingChanges: async (path: string): Promise<WorkingChanges> =>
    // The schema defaults `conflicted` to [] (the long-standing defensive
    // contract, so every consumer can rely on the field) and rejects any other
    // shape drift with a clear IpcValidationError.
    parse(workingChangesSchema, await invoke("working_changes", { path }), "working_changes"),

  /** Diff for a working-tree file. `staged` true → index vs HEAD; false → worktree vs index.
   * `full` bypasses the backend line cap (for an explicit "show full diff"). */
  fileDiff: async (path: string, file: string, staged: boolean, full?: boolean): Promise<FileDiff> =>
    parse(fileDiffSchema, await invoke("file_diff", { path, file, staged, full: full ?? null }), "file_diff"),

  /** Changed files in a commit (vs its first parent). */
  commitFiles: (path: string, oid: string) =>
    invoke<FileChange[]>("commit_files", { path, oid }),

  /** Read a binary blob's bytes (base64) for an inline preview. Pass `oid` for a
   * committed/staged blob; pass `file` (repo-relative, `oid` omitted) to read the
   * working-tree copy — the side an unstaged diff leaves without a blob oid. */
  readBinaryBlob: (
    path: string,
    source: { oid?: string | null; file?: string | null },
    maxBytes?: number,
  ) =>
    invoke<BinaryBlob>("read_binary_blob", {
      path,
      oid: source.oid ?? null,
      file: source.file ?? null,
      maxBytes: maxBytes ?? null,
    }),

  /** Diff for one file within a commit (vs its first parent). `full` bypasses
   * the backend line cap (for an explicit "show full diff"). */
  commitFileDiff: async (path: string, oid: string, file: string, full?: boolean): Promise<FileDiff> =>
    parse(
      fileDiffSchema,
      await invoke("commit_file_diff", { path, oid, file, full: full ?? null }),
      "commit_file_diff",
    ),

  /** Changed files across a range base..head (either side accepts any
   * commit-ish: a SHA, "HEAD", a branch). */
  diffRange: (path: string, base: string, head: string) =>
    invoke<FileChange[]>("diff_range", { path, base, head }),

  /** Diff for one file across a range base..head. `full` bypasses the backend
   * line cap (for an explicit "show full diff"). */
  diffRangeFile: async (
    path: string,
    base: string,
    head: string,
    file: string,
    full?: boolean,
  ): Promise<FileDiff> =>
    parse(
      fileDiffSchema,
      await invoke("diff_range_file", { path, base, head, file, full: full ?? null }),
      "diff_range_file",
    ),

  /** Merged ("union") changed files across a multi-commit selection (GL-69): the
   * net change per file across `oids` (in any order), with status + counts. For
   * each file the net is computed from its state before the earliest selected
   * commit that touches it to its state after the latest one. */
  selectionDiff: (path: string, oids: string[]) =>
    invoke<FileChange[]>("selection_diff", { path, oids }),

  /** Merged diff for one file across a multi-commit selection (see
   * {@link selectionDiff}). `full` bypasses the backend line cap. */
  selectionDiffFile: async (
    path: string,
    oids: string[],
    file: string,
    full?: boolean,
  ): Promise<FileDiff> =>
    parse(
      fileDiffSchema,
      await invoke("selection_diff_file", { path, oids, file, full: full ?? null }),
      "selection_diff_file",
    ),

  /** Bounded newest-first history for a repository-relative file path. */
  fileHistory: (path: string, file: string, offset?: number, limit?: number) =>
    invoke<FileHistoryPage>("file_history", {
      path,
      file,
      offset: offset ?? null,
      limit: limit ?? null,
    }),

  /** Line-level attribution for a text file at a revision or the working tree. */
  fileBlame: (path: string, file: string, revision?: string | null, limit?: number) =>
    invoke<FileBlame>("file_blame", {
      path,
      file,
      revision: revision ?? null,
      limit: limit ?? null,
    }),

  /** Changed files plus totals for a `base..head` comparison. `head = null`
   * compares `base` against the working tree. */
  compareRefs: (path: string, base: string, head?: string | null) =>
    invoke<CompareResult>("compare_refs", { path, base, head: head ?? null }),

  /** Full diff for one file within a comparison (see [`compareRefs`]). */
  compareFileDiff: async (
    path: string,
    base: string,
    head: string | null,
    file: string,
    full?: boolean,
  ): Promise<FileDiff> =>
    parse(
      fileDiffSchema,
      await invoke("compare_file_diff", { path, base, head: head ?? null, file, full: full ?? null }),
      "compare_file_diff",
    ),

  stageFile: (path: string, file: string) =>
    invoke<string>("stage_file", { path, file }),

  unstageFile: (path: string, file: string) =>
    invoke<string>("unstage_file", { path, file }),

  /** Stage one hunk from an unstaged diff, or unstage one hunk from a staged diff.
   * `expectedBody` is the displayed hunk's canonical body; the backend rejects the
   * stage if the current patch's hunk content no longer matches it. */
  applyHunk: (
    path: string,
    file: string,
    staged: boolean,
    hunkIndex: number,
    expectedHeader: string,
    expectedBody: string,
  ) => invoke<string>("apply_hunk", { path, file, staged, hunkIndex, expectedHeader, expectedBody }),

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

  /** Stage several files atomically (one `git add -A`). */
  stageFiles: (path: string, files: string[]) =>
    invoke<string>("stage_files", { path, files }),

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
  /** Write a commit identity into the repo's local git config. `signing` is
   * optional; when given, its fields apply per-key (empty string unsets). */
  setRepoIdentity: (path: string, name: string, email: string, signing?: RepoSigningConfig) =>
    invoke<string>("set_repo_identity", {
      path,
      name,
      email,
      signingKey: signing?.signingKey,
      gpgFormat: signing?.gpgFormat,
      gpgSign: signing?.gpgSign,
      tagGpgSign: signing?.tagGpgSign,
    }),

  /** Signing keys the user already has (GPG secret keys + SSH public keys) for
   * the profile editor's key picker. References only — never private material. */
  listSigningKeys: () => invoke<SigningKey[]>("list_signing_keys"),

  /** Read the identity pinned in the repo's local git config (the durable,
   * build-independent source of truth). `null` = nothing pinned locally. */
  repoIdentity: (path: string) => invoke<RepoIdentity | null>("repo_identity", { path }),

  /** The default commit identity from global git config — the fallback git uses
   * when nothing is pinned locally. Powers the "Default git identity" profile
   * option. `null` when no global name/email is set. */
  defaultGitIdentity: () => invoke<RepoIdentity | null>("default_git_identity"),

  /** Remove the pinned identity from local git config (defer to global). */
  clearRepoIdentity: (path: string) => invoke<string>("clear_repo_identity", { path }),

  // ---- repository onboarding (clone / init / recents) ----

  /** Clone `url` into `dest`, streaming `clone-progress` events while it runs.
   * Resolves with the cloned repo's path; the caller then opens it. Reject with
   * the git failure text (classified UI-side into exists/auth/unreachable). */
  cloneRepo: (url: string, dest: string) => invoke<string>("clone_repo", { url, dest }),

  /** Cancel an in-flight {@link cloneRepo} (kills the `git clone` child). */
  cancelClone: () => invoke<void>("cancel_clone"),

  /** Initialize a new repo at `parent`/`name` on `branch`, optionally seeding a
   * README and a `.gitignore` template. Resolves with the new repo's path. */
  initRepo: (
    parent: string,
    name: string,
    branch: string,
    readme: boolean,
    gitignore: string,
  ) => invoke<string>("init_repo", { parent, name, branch, readme, gitignore }),

  /** Presence + current branch for each recent repo path (missing-path + branch
   * info for the onboarding "Recent" list). */
  recentsStatus: (paths: string[]) => invoke<RecentStatus[]>("recents_status", { paths }),

  /** Reveal `path` in the OS file manager (Finder/Explorer). */
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),

  /** Start watching `path`; the backend emits `repo-changed` on any change. */
  watchRepo: (path: string) => invoke<void>("watch_repo", { path }),
};
