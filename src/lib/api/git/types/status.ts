// Working-tree status + advanced repo state — mirrors
// `src-tauri/src/git/types/status.rs`.

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
