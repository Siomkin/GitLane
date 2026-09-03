// Branch lifecycle and the history grafts that run against a checked-out
// branch: checkout, create, delete, rename, upstream, merge, fast-forward,
// rebase, reset, cherry-pick, revert. Mirrors `commands/branches.rs`.

import { invoke } from "@/lib/api/invoke";
import { parse } from "@/lib/api/validate";
import { z } from "zod";

export const branchesApi = {
  checkout: async (path: string, target: string, detached = false) =>
    parse(z.string(), await invoke("checkout", { path, target, detached }), "checkout"),

  /** Check out the local counterpart of `remote/branch`, creating it with
   * tracking or safely fast-forwarding the existing local branch. */
  checkoutRemoteBranch: async (path: string, remote: string, branch: string) =>
    parse(
      z.string(),
      await invoke("checkout_remote_branch", { path, remote, branch }),
      "checkout_remote_branch",
    ),

  /** Create a branch at `startPoint` (the ref the user picked, so a
   * remote-tracking start point keeps git's automatic upstream setup), pinned
   * to the `expectedOid` the user saw. */
  createBranch: async (path: string, name: string, startPoint: string, expectedOid: string) =>
    parse(
      z.string(),
      await invoke("create_branch", { path, name, startPoint, expectedOid }),
      "create_branch",
    ),

  deleteBranch: async (path: string, name: string, expectedOid: string, force = false) =>
    parse(
      z.string(),
      await invoke("delete_branch", { path, name, expectedOid, force }),
      "delete_branch",
    ),

  renameBranch: async (path: string, oldName: string, newName: string) =>
    parse(
      z.string(),
      await invoke("rename_branch", { path, old: oldName, new: newName }),
      "rename_branch",
    ),

  /** Point `branch`'s upstream at the remote-tracking ref `upstream` (e.g.
   * "origin/main"). The ref must already exist. */
  setUpstream: async (path: string, branch: string, upstream: string) =>
    parse(z.string(), await invoke("set_upstream", { path, branch, upstream }), "set_upstream"),

  mergeBranch: async (
    path: string,
    source: string,
    expectedSourceOid: string,
    destination: string | null,
    expectedDestinationOid: string,
  ) =>
    parse(
      z.string(),
      await invoke("merge_branch", {
        path,
        source,
        expectedSourceOid,
        destination,
        expectedDestinationOid,
      }),
      "merge_branch",
    ),

  /** Fast-forward the explicit branch from its expected oid to a captured
   * target oid. Rust chooses the live checked-out/non-checked-out mechanism. */
  fastForwardBranch: async (
    path: string,
    branch: string,
    expectedBranchOid: string,
    targetOid: string,
  ) =>
    parse(
      z.string(),
      await invoke("fast_forward_branch", { path, branch, expectedBranchOid, targetOid }),
      "fast_forward_branch",
    ),

  /** Rebase the explicit `source` branch/revision onto `onto`; the backend
   * carries both operands through one git process instead of trusting HEAD. */
  rebaseOnto: async (path: string, source: string, expectedSourceOid: string, ontoOid: string) =>
    parse(
      z.string(),
      await invoke("rebase_onto", { path, source, expectedSourceOid, ontoOid }),
      "rebase_onto",
    ),

  resetTo: async (
    path: string,
    source: string | null,
    expectedSourceOid: string | null,
    targetOid: string,
    mode: "soft" | "mixed" | "hard",
    expectedState?: string | null,
    expectedHeadBranch?: string | null,
    expectedHeadOid?: string | null,
  ) =>
    parse(
      z.string(),
      await invoke("reset_to", {
        path,
        source,
        expectedSourceOid,
        targetOid,
        mode,
        expectedState: expectedState ?? null,
        expectedHeadBranch: expectedHeadBranch ?? null,
        expectedHeadOid: expectedHeadOid ?? null,
      }),
      "reset_to",
    ),

  /** Cherry-pick several commits in one atomic `git cherry-pick A B C…`. */
  cherryPickMany: async (
    path: string,
    expectedBranch: string | null,
    expectedOid: string,
    commits: string[],
  ) =>
    parse(
      z.string(),
      await invoke("cherry_pick_many", { path, expectedBranch, expectedOid, commits }),
      "cherry_pick_many",
    ),

  /** Revert several commits in one atomic `git revert --no-edit A B…`. */
  revertMany: async (
    path: string,
    expectedBranch: string | null,
    expectedOid: string,
    commits: string[],
  ) =>
    parse(
      z.string(),
      await invoke("revert_many", { path, expectedBranch, expectedOid, commits }),
      "revert_many",
    ),
};
