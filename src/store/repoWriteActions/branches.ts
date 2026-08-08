// Local-branch lifecycle: create, delete, rename, and upstream wiring, plus the
// two thin preview/delete pass-throughs the GL-107 dialog drives.

import { api } from "@/lib/api";
import type { RepoGet, RepoState } from "@/store/repoTypes";
import {
  captureOwner,
  refreshIfCurrent,
  requireHeadOid,
  revisionSnapshot,
  runOp,
} from "./shared";

export function createBranchActions(
  get: RepoGet,
): Pick<
  RepoState,
  | "createBranchAt"
  | "createBranchInWorktree"
  | "removeBranch"
  | "renameBranchTo"
  | "setUpstreamFor"
  | "previewDeleteBranch"
  | "deleteBranchWithWorktree"
> {
  return {
    // Branch operations. Each refreshes the graph and returns a human-readable
    // outcome string; callers toast errors only (routine success is silent).
    // Failures reject with the git error so the caller can toast that instead.
    createBranchAt: (name, startPoint) =>
      runOp(get, async (summary) => {
        // Send the picked ref (not its oid) as the start point so branching
        // from a remote-tracking ref keeps git's automatic upstream setup; the
        // captured oid pins it to the commit the user saw.
        const start = startPoint
          ? revisionSnapshot(get, startPoint)
          : { revision: "HEAD", oid: requireHeadOid(summary, "create a branch") };
        await api.createBranch(summary.path, name, start.revision, start.oid);
        await api.checkout(summary.path, name, false);
        return `Created ${name}`;
      }),

    createBranchInWorktree: (worktreePath, name, expectedOid) =>
      runOp(get, (summary) =>
        api.createBranchInWorktree(summary.path, worktreePath, name, expectedOid),
      ),

    // The confirmation owns both the exact ref oid and repository path it
    // previewed. Do not route this through runOp (which reads the live summary
    // after the user confirms): a repo switch must never retarget the old
    // dialog's destructive action to the newly-active repository.
    removeBranch: async (name, expectedOid, repoPath, force = false) => {
      if (!repoPath) throw new Error("No repository");
      const active = get().summary;
      if (active?.path !== repoPath) {
        throw new Error("Repository changed; preview the branch deletion again.");
      }
      const owner = captureOwner(active);
      const message = await api.deleteBranch(repoPath, name, expectedOid, force);
      await refreshIfCurrent(get, owner);
      return message || `Deleted ${name}`;
    },

    renameBranchTo: (oldName, newName) =>
      runOp(get, async (summary) => {
        await api.renameBranch(summary.path, oldName, newName);
        return `Renamed ${oldName} → ${newName}`;
      }),

    setUpstreamFor: (branch, upstream) =>
      runOp(get, async (summary) => {
        await api.setUpstream(summary.path, branch, upstream);
        return `Set upstream of ${branch} to ${upstream}`;
      }),

    // Thin pass-throughs for the GL-107 delete-branch-and-worktree dialog: it is
    // UI and must not reach `api` directly (architecture-rules-react.md §1), so
    // the boundary lives here. Unlike the other branch writes these skip `runOp`'s
    // refresh — the dialog owns the graph refresh so it can surface it as the
    // checklist's "Refreshing" row (see useDeleteWorktreeRun).
    previewDeleteBranch: (branch) => {
      const { summary } = get();
      if (!summary) return Promise.reject(new Error("No repository"));
      return api.previewDeleteBranch(summary.path, branch);
    },

    // `repoPath` is passed explicitly (not read from `get().summary`) so the delete
    // is pinned to the repo the dialog started on. The op runs after an `await` in
    // the dialog's run hook, and a repo switch landing in that window would
    // otherwise retarget the delete at the newly-active repo with the old
    // branch/worktree subject. GL-107 review.
    deleteBranchWithWorktree: (
      branch,
      fromWorktreePath,
      repoPath,
      expectedOid,
      expectedState,
    ) => {
      if (!repoPath) return Promise.reject(new Error("No repository"));
      return api.deleteBranchWithWorktree(
        repoPath,
        branch,
        fromWorktreePath,
        expectedOid,
        expectedState,
      );
    },
  };
}
