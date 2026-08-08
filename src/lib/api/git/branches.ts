// Branch lifecycle and the history grafts that run against a checked-out
// branch: checkout, create, delete, rename, upstream, merge, fast-forward,
// rebase, reset, cherry-pick, revert. Mirrors `commands/branches.rs`.

import { invoke } from "@tauri-apps/api/core";

export const branchesApi = {
  checkout: (path: string, target: string, detached = false) =>
    invoke<string>("checkout", { path, target, detached }),

  /** Check out the local counterpart of `remote/branch`, creating it with
   * tracking or safely fast-forwarding the existing local branch. */
  checkoutRemoteBranch: (path: string, remote: string, branch: string) =>
    invoke<string>("checkout_remote_branch", { path, remote, branch }),

  /** Create a branch at `startPoint` (the ref the user picked, so a
   * remote-tracking start point keeps git's automatic upstream setup), pinned
   * to the `expectedOid` the user saw. */
  createBranch: (path: string, name: string, startPoint: string, expectedOid: string) =>
    invoke<string>("create_branch", { path, name, startPoint, expectedOid }),

  deleteBranch: (path: string, name: string, expectedOid: string, force = false) =>
    invoke<string>("delete_branch", { path, name, expectedOid, force }),

  renameBranch: (path: string, oldName: string, newName: string) =>
    invoke<string>("rename_branch", { path, old: oldName, new: newName }),

  /** Point `branch`'s upstream at the remote-tracking ref `upstream` (e.g.
   * "origin/main"). The ref must already exist. */
  setUpstream: (path: string, branch: string, upstream: string) =>
    invoke<string>("set_upstream", { path, branch, upstream }),

  mergeBranch: (
    path: string,
    source: string,
    expectedSourceOid: string,
    destination: string | null,
    expectedDestinationOid: string,
  ) => invoke<string>("merge_branch", {
    path,
    source,
    expectedSourceOid,
    destination,
    expectedDestinationOid,
  }),

  /** Fast-forward the explicit branch from its expected oid to a captured
   * target oid. Rust chooses the live checked-out/non-checked-out mechanism. */
  fastForwardBranch: (
    path: string,
    branch: string,
    expectedBranchOid: string,
    targetOid: string,
  ) => invoke<string>("fast_forward_branch", { path, branch, expectedBranchOid, targetOid }),

  /** Rebase the explicit `source` branch/revision onto `onto`; the backend
   * carries both operands through one git process instead of trusting HEAD. */
  rebaseOnto: (path: string, source: string, expectedSourceOid: string, ontoOid: string) =>
    invoke<string>("rebase_onto", { path, source, expectedSourceOid, ontoOid }),

  resetTo: (
    path: string,
    source: string | null,
    expectedSourceOid: string | null,
    targetOid: string,
    mode: "soft" | "mixed" | "hard",
    expectedState?: string | null,
    expectedHeadBranch?: string | null,
    expectedHeadOid?: string | null,
  ) =>
    invoke<string>("reset_to", {
      path,
      source,
      expectedSourceOid,
      targetOid,
      mode,
      expectedState: expectedState ?? null,
      expectedHeadBranch: expectedHeadBranch ?? null,
      expectedHeadOid: expectedHeadOid ?? null,
    }),

  cherryPick: (path: string, expectedBranch: string | null, expectedOid: string, commit: string) =>
    invoke<string>("cherry_pick", { path, expectedBranch, expectedOid, commit }),

  /** Cherry-pick several commits in one atomic `git cherry-pick A B C…`. */
  cherryPickMany: (
    path: string,
    expectedBranch: string | null,
    expectedOid: string,
    commits: string[],
  ) => invoke<string>("cherry_pick_many", { path, expectedBranch, expectedOid, commits }),

  revertCommit: (path: string, expectedBranch: string | null, expectedOid: string, commit: string) =>
    invoke<string>("revert_commit", { path, expectedBranch, expectedOid, commit }),

  /** Revert several commits in one atomic `git revert --no-edit A B…`. */
  revertMany: (
    path: string,
    expectedBranch: string | null,
    expectedOid: string,
    commits: string[],
  ) => invoke<string>("revert_many", { path, expectedBranch, expectedOid, commits }),
};
