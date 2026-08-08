// Every serde struct the Rust side returns across IPC, plus the const enums
// whose values the backend emits. Mirrors `src-tauri/src/git/types/` — keep the
// field names in sync; the Rust structs are all `rename_all = "camelCase"`.

import type { GithubAccountRef } from "@/lib/api/github";

/** Kind of ref a graph label carries, emitted by the backend. Compare against
 * `RefKind.Tag` rather than a bare `"tag"` literal so a typo fails to compile.
 * Keep in sync with the Rust side across the IPC boundary. */
export const RefKind = {
  Branch: "branch",
  Remote: "remote",
  Tag: "tag",
  Head: "head",
} as const;
export type RefKind = (typeof RefKind)[keyof typeof RefKind];

/** Kind of a branch entry / drag ref (a *local* or *remote-tracking* branch),
 * distinct from `RefKind` (which also covers tags/HEAD). Same const-object rule:
 * compare against `BranchKind.Local`, not `"local"`. */
export const BranchKind = {
  Local: "local",
  Remote: "remote",
} as const;
export type BranchKind = (typeof BranchKind)[keyof typeof BranchKind];

export interface RefLabel {
  name: string;
  kind: RefKind;
  /** Exact object named by a tag ref. Unlike the containing commit id, this is
   * the annotated-tag object oid and is used as the deletion CAS token. */
  targetOid?: string | null;
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
  /** Zero-based parent index on the child commit; > 0 means merge parent.
   * Always present — the Rust `GraphEdge` sends it on every edge. */
  parentIndex: number;
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

export interface HistorySearchQuery {
  messagePattern?: string;
  author?: string;
  path?: string;
  revision?: string;
  changedPattern?: string;
  occurrenceText?: string;
  /** Inclusive committer-date bounds, epoch seconds (git log --since/--until). */
  sinceTimestamp?: number;
  untilTimestamp?: number;
  limit?: number;
}

export interface HistorySearchResult {
  id: string;
  shortId: string;
  summary: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
}

export interface HistorySearchPage {
  results: HistorySearchResult[];
  truncated: boolean;
  workTruncated: boolean;
}

export interface RepoSummary {
  path: string;
  workdir: string | null;
  headBranch: string | null;
  headOid: string | null;
  detached: boolean;
  /** True when HEAD is unborn (fresh `git init`, no commits yet) — the UI
   * shows "No commits yet" instead of "No branch". Optional for
   * backward-compatible fixtures; the backend always sends it. */
  unborn?: boolean;
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
 * Reference only — a full GPG fingerprint or SSH public-key path, never private
 * material. */
export interface SigningKey {
  /** Written to `user.signingkey` — a full GPG fingerprint or SSH public-key
   * path. */
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

export type GitTransportAuthMode =
  | "system"
  | "ssh"
  | "githubGh"
  | "gitlabGlab"
  | "credentialHelper"
  | "providerToken";
export type GitTransportProvider =
  | "github"
  | "gitlab"
  | "bitbucket"
  | "azure-devops"
  | "gitea"
  | "forgejo"
  | "other";

/** Provider-neutral git transport auth for clone/fetch/pull/push. Never carries
 * tokens; HTTPS identities are URL usernames resolved by git credential helpers,
 * except `providerToken` mode, where the backend fetches a GitLane-owned token
 * from the OS keychain via GIT_ASKPASS (GL-132) using `providerAccountId` — a
 * non-secret keychain locator — rather than any token on this ref. */
export interface GitTransportAuthRef {
  mode: GitTransportAuthMode;
  provider?: GitTransportProvider;
  /** Display/classification host, without port. */
  host: string;
  /** Exact credential authority (`host[:port]`) Git passes to helpers. */
  credentialHost: string;
  /** HTTPS URL username, if one is selected. */
  username?: string | null;
  /** GitHub account metadata for `githubGh`; still no token. */
  accountRef?: GithubAccountRef | null;
  /** Keychain locator for `providerToken` mode; never a token. */
  providerAccountId?: string | null;
  /** Match Git's credential.useHttpPath lookup for path-scoped credentials. */
  useHttpPath?: boolean;
}

/** One `remote → auth` pair for the multi-remote fetch. */
export interface RemoteAccountRef {
  remote: string;
  auth: GitTransportAuthRef;
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
  kind: BranchKind;
  target: string | null;
  /** Committer time (epoch seconds) of the branch tip. Git stores no branch
   * creation time, so this stands in for "last updated" — what the navigator
   * orders branches and remotes by. `null` when the tip can't be resolved.
   * Optional here to match its siblings (`upstreamRemote`, `sync`), which are
   * also always-serialized Rust `Option`s — fixtures stay terse, and consumers
   * treat a missing value the same as `null`. */
  tipTime?: number | null;
  isHead: boolean;
  upstream: string | null;
  /** For a remote branch, the remote it belongs to (resolved by the backend
   * against the known remote list). `null` for local branches. */
  remote: string | null;
  /** For a local branch, its configured fetch/upstream remote
   * (`branch.<name>.remote`); `.` means another branch in this repository.
   * `null` for remote branches or when unset. */
  upstreamRemote?: string | null;
  /** For a local branch, the actual push remote after Git's
   * branch.pushRemote → remote.pushDefault → branch.remote → origin
   * precedence. `null` for remote branches. */
  pushRemote?: string | null;
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

/** Reset impact plus the exact tips / optional hard-reset worktree lease. */
export interface ResetPreview extends DestructivePreview {
  /** Exact commit the reset will move to — never a symbolic name that can move. */
  targetOid: string;
  /** Tip of the source branch/HEAD observed by the preview. */
  expectedSourceOid: string | null;
  /** Opaque repository/HEAD/index/worktree fingerprint. Present only for hard. */
  expectedState: string | null;
  /** Symbolic branch observed with the hard-reset lease, or null when detached. */
  expectedHeadBranch: string | null;
  /** HEAD commit observed with the hard-reset lease, or null when unborn. */
  expectedHeadOid: string | null;
}

export interface ForcePushRouteLease {
  /** Push route resolved with Git's pushRemote / pushDefault precedence. */
  remote: string;
  /** Fully-qualified server-side destination, e.g. refs/heads/main. */
  destinationRef: string;
  /** Full oid observed in the destination's local tracking ref; null means the
   * preview requires that destination to remain absent. */
  destinationOid: string | null;
  /** Opaque fingerprint of the previewed single effective push endpoint. */
  pushEndpointToken: string;
}

export interface ForcePushPreview extends DestructivePreview, ForcePushRouteLease {
  /** Full local branch object shown by the confirmation and used as the push
   * source. */
  expectedOid: string;
}

export interface DeleteBranchPreview extends DestructivePreview {
  /** Full object id of the exact refs/heads/<branch> value previewed. */
  expectedOid: string;
}

export interface DiscardFilePreview extends DestructivePreview {
  /** Opaque backend fingerprint of the exact HEAD/index/worktree state shown
   * by the confirmation. Required again by the destructive write. */
  expectedState: string;
}

export interface DiscardAllPreview extends DestructivePreview {
  /** Opaque backend fingerprint of the exact repository, HEAD, index, and
   * affected worktree leaves shown by the confirmation. */
  expectedState: string;
  /** Symbolic branch observed by the preview, or null for detached HEAD. An
   * unborn repository still has a branch while its commit OID remains null. */
  expectedHeadBranch: string | null;
  /** Commit observed by the preview, or null for an unborn repository. */
  expectedHeadOid: string | null;
}

/** Whether `.git/index.lock` is present and safe to remove (GL-335). */
export interface IndexLockStatus {
  present: boolean;
  /** True only when the lock looks orphaned (old mtime, no openers). */
  stale: boolean;
  /** Short human reason — shown when recovery is refused. */
  detail: string;
}

/** Shared Linked Worktree Removal preview + Worktree Removal Lease (GL-303). */
export interface RemoveWorktreePreview extends DestructivePreview {
  /** Opaque fingerprint of registration, directory identity, branch/HEAD, and
   * porcelain dirty path+status. Required again by the destructive write. */
  expectedState: string;
  /** True when the server will derive `--force` / `-f -f` after the lease matches. */
  requiresForce: boolean;
  locked: boolean;
  branch: string | null;
  headOid: string | null;
  dirty: WorktreeDirtyState;
}

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string | null;
  /** Commit oid the worktree's HEAD points at, or null for a bare entry — how a
   * detached worktree (no branch) is located in the graph. Optional for
   * backward-compatible fixtures; the backend always sends it. */
  head?: string | null;
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

/** Uncommitted work in a linked worktree, probed on demand before a removal
 * (GL-296). Not part of `WorktreeInfo` — see `api.worktreeDirtyState`. */
export interface WorktreeDirtyState {
  /** Changed tracked files — destroyed by a forced remove, with no reflog. */
  modified: number;
  /** Untracked files, counted individually (`--untracked-files=all`). */
  untracked: number;
  /** Ignored entries, counted with directories COLLAPSED (`node_modules/` is
   * one). Git deletes these on an unforced removal, so they never make a
   * worktree dirty — but a local `.env` is ignored too, so a removal says they
   * are going rather than letting them vanish unmentioned. */
  ignored: number;
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
  /** `add` is a lower bound because a large untracked text file was counted
   * only through the backend's bounded probe. Absent means the count is exact. */
  lineCountTruncated?: boolean;
  /** For a rename ("R") or copy ("C"), the file's previous (old-side) path — the
   * rename/copy source. For a rename it is the *staging* counterpart: a worktree
   * rename shows as one "R" naming only the new path, so staging/unstaging it must
   * act on both `previousPath` and `path` together, else the old path's deletion
   * is left behind (GL-127). For a copy the source is unchanged, so it's carried
   * for display only and never staged alongside. Absent for every other change. */
  previousPath?: string;
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
  /** Advanced repo state (submodules, LFS, sparse-checkout). Always present —
   * the Rust `WorkingChanges` sends it on every read. */
  advanced: AdvancedRepoState;
}

/** The active in-progress operation that can stop on conflicts. "none" when the
 * repo is clean / no operation is underway. "carry" is GitLane's worktree-handoff
 * carry (GL-74) — a stash re-apply left conflicts with no git sequencer state. */
export type OperationKind = "merge" | "rebase" | "cherry-pick" | "revert" | "carry" | "none";

/** Non-drivable in-progress git state surfaced as a read-only banner (GitLane
 * can't continue/abort these in-app): `git am` or bisect. "" when the repo is
 * clean or in a drivable operation. */
export type OperationAdvisory = "apply-mailbox" | "bisect" | "";

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
  /** A non-drivable in-progress state (git am / bisect) shown as a read-only
   * banner, independent of the drivable `kind`. */
  advisory: OperationAdvisory;
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

/** One worktree file's text for the read-only file viewer. Binary and
 * oversized files come back as flags (`text` absent / `truncated`). */
export interface RepoFileContent {
  text?: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  /** Opaque lease for the exact repo/worktree/path, leaf identity, and raw bytes
   * represented by `text`. Omitted for truncated, binary, or lossy/non-UTF-8
   * reads, which are display-only. */
  expectedState?: string;
}

export interface RepoFileWriteResult {
  size: number;
  expectedState: string;
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
