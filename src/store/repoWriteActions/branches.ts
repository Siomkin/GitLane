// Local-branch lifecycle: create, delete, rename, and upstream wiring, plus the
// two thin preview/delete pass-throughs the GL-107 dialog drives.

import { api, type BranchDeleteOutcome } from "@/lib/api";
import { StepOutcomeError } from "@/lib/gitError";
import type { RepoGet, RepoSet, RepoState } from "@/store/repoTypes";
import {
  captureOwner,
  ownerIsCurrent,
  type RepoWriteOwner,
  refreshIfCurrent,
  requireHeadOid,
  revisionSnapshot,
  runOp,
} from "./shared";
import { runPendingCheckout, withCheckoutFeedback } from "./checkoutFeedback";
import { authFor, trackNet } from "./net";
import { withActiveRefWrite, withRefWrite } from "./refWritePending";

/** Refresh after a delete without letting a refresh failure stand in for the
 * delete's outcome: the ref is already gone (or kept) whatever the refresh
 * does, and the repo watcher retries the reload. */
async function refreshQuietly(get: RepoGet, owner: RepoWriteOwner) {
  try {
    await refreshIfCurrent(get, owner);
  } catch {
    // Keep the delete's own result primary; see useDeleteWorktreeRun.
  }
}

export function createBranchActions(
  set: RepoSet,
  get: RepoGet,
): Pick<
  RepoState,
  | "createBranchAt"
  | "createBranchInWorktree"
  | "removeBranch"
  | "deleteBranchAndRemote"
  | "renameBranchTo"
  | "setUpstreamFor"
  | "previewDeleteBranch"
  | "previewDeleteRemoteBranch"
  | "deleteBranchWithWorktree"
> {
  return {
    // Branch operations. Each refreshes the graph and returns a human-readable
    // outcome string; callers toast errors only (routine success is silent).
    // Failures reject with the git error so the caller can toast that instead.
    // A pending checkout, so it is refused while another checkout runs and
    // refuses one itself — it is checked out the moment it is created.
    createBranchAt: (name, startPoint) =>
      runPendingCheckout(set, get, { ref: name, kind: "local", label: name }, (_s, _o, endProgress) =>
        runOp(get, async (summary, owner) => {
        // Send the picked ref (not its oid) as the start point so branching
        // from a same-named remote-tracking ref keeps git's automatic upstream
        // setup; a differently-named start is created `--no-track`. The captured
        // oid pins it to the commit the user saw.
        const start = startPoint
          ? revisionSnapshot(get, startPoint)
          : { revision: "HEAD", oid: requireHeadOid(summary, "create a branch") };
        await api.createBranch(summary.path, name, start.revision, start.oid);
        await withCheckoutFeedback(name, () => api.checkout(summary.path, name, false), {
          repoPath: owner.path,
          isCurrent: () => ownerIsCurrent(get, owner),
          endProgress,
        });
        return `Created ${name}`;
      }),
      ),

    createBranchInWorktree: (worktreePath, name, expectedOid) =>
      runOp(get, (summary) =>
        api.createBranchInWorktree(summary.path, worktreePath, name, expectedOid),
      ),

    // The confirmation owns both the exact ref oid and repository path it
    // previewed. Do not route this through runOp (which reads the live summary
    // after the user confirms): a repo switch must never retarget the old
    // dialog's destructive action to the newly-active repository.
    removeBranch: async (name, expectedOid, repoPath, force = false, onDeleted) => {
      if (!repoPath) throw new Error("No repository");
      const active = get().summary;
      if (active?.path !== repoPath) {
        throw new Error("Repository changed; preview the branch deletion again.");
      }
      const owner = captureOwner(active);
      return withRefWrite(set, get, repoPath, [{ name, kind: "local" }], async () => {
        const outcome = await api.deleteBranch(repoPath, name, expectedOid, force);
        onDeleted?.();
        await refreshQuietly(get, owner);
        return outcome;
      });
    },

    // Remote first: a failed push (auth, network, moved lease) leaves both refs
    // untouched and retryable; a later local failure leaves a visible, finishable
    // state. Both steps use the confirmed `repoPath`, never the live summary.
    deleteBranchAndRemote: async (name, localOid, target, repoPath, onStep) => {
      const active = get().summary;
      if (!repoPath || active?.path !== repoPath) {
        throw new Error("Repository changed; preview the branch deletion again.");
      }
      const owner = captureOwner(active);
      const remoteRef = `${target.remote}/${target.branch}`;
      const refs = [{ name, kind: "local" as const }, { name: remoteRef, kind: "remote" as const }];
      return withRefWrite(set, get, repoPath, refs, async () => {
        try {
          await trackNet(set, get, () =>
            api.deleteRemoteBranch(repoPath, target.remote, target.branch, target.oid, authFor(target.remote)),
          );
        } catch (e) {
          throw new StepOutcomeError(`Nothing was deleted: ${remoteRef} could not be deleted.`, e);
        }
        onStep?.("local");
        let local: BranchDeleteOutcome;
        try {
          // Owns the local guard (repo still active) and the refresh on success.
          local = await get().removeBranch(name, localOid, repoPath, true, () => onStep?.("refresh"));
        } catch (e) {
          await refreshQuietly(get, owner);
          throw new StepOutcomeError(`${remoteRef} was deleted, but ${name} was kept.`, e);
        }
        // The local delete's warning (branch settings left behind) carries over.
        return { message: `Deleted ${name} and ${remoteRef}`, warning: local.warning };
      });
    },

    renameBranchTo: (oldName, newName) =>
      withActiveRefWrite(set, get, [{ name: oldName, kind: "local" }], () =>
        runOp(get, async (summary) => {
          await api.renameBranch(summary.path, oldName, newName);
          return `Renamed ${oldName} → ${newName}`;
        }),
      ),

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
    previewDeleteRemoteBranch: (remote, branch) => {
      const { summary } = get();
      if (!summary) return Promise.reject(new Error("No repository"));
      return api.previewDeleteRemoteBranch(summary.path, remote, branch);
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
      afterDelete,
    ) => {
      if (!repoPath) return Promise.reject(new Error("No repository"));
      // The dialog's refresh runs inside the pending window, so the pill keeps
      // its spinner until the deleted ref leaves the graph.
      return withRefWrite(set, get, repoPath, [{ name: branch, kind: "local" }], async () => {
        const outcome = await api.deleteBranchWithWorktree(
          repoPath,
          branch,
          fromWorktreePath,
          expectedOid,
          expectedState,
        );
        await afterDelete?.();
        return outcome;
      });
    },
  };
}
