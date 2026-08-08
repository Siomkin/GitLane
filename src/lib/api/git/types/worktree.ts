// Linked-worktree info + removal previews — mirrors
// `src-tauri/src/git/types/worktree.rs`.

import type { DestructivePreview } from "./preview";

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
