// Destructive-operation previews + leases — mirrors
// `src-tauri/src/git/types/preview.rs`.

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
