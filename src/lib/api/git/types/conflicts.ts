// In-progress operations + conflicted files — mirrors
// `src-tauri/src/git/types/conflicts.rs`.

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
