// Stash writes. Routine success is silent — `toastStashOutcome` only speaks up
// for recovered / partial-cleanup outcomes.

import { api } from "@/lib/api";
import { guardedAdvancedWriteMessage } from "@/lib/advancedRepoState";
import type { RepoGet, RepoState } from "@/store/repoTypes";
import {
  captureOwner,
  guardedPathMessage,
  refreshIfCurrent,
  runOp,
  toastAdvancedGuard,
  toastStashOutcome,
  toastWriteError,
} from "./shared";

export function createStashActions(
  get: RepoGet,
): Pick<RepoState, "applyStash" | "branchFromStash" | "dropStash" | "stash" | "stashFile"> {
  return {
    applyStash: (oid, pop, withIndex) =>
      runOp(get, async (summary) => {
        if (pop) await api.stashPop(summary.path, summary.headBranch, summary.headOid, oid);
        else if (withIndex) {
          await api.stashApplyIndex(summary.path, summary.headBranch, summary.headOid, oid);
        } else {
          await api.stashApply(summary.path, summary.headBranch, summary.headOid, oid);
        }
        return pop ? "Popped stash" : "Applied stash";
      }),

    branchFromStash: (oid, branch) =>
      runOp(get, async (summary) => {
        await api.stashBranch(summary.path, branch, oid);
        return `Applied stash to new branch ${branch}`;
      }),

    dropStash: (oid) =>
      runOp(get, async (summary) => {
        await api.stashDrop(summary.path, oid);
        return "Dropped stash";
      }),

    stashFile: async (path) => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      if (toastAdvancedGuard(guardedPathMessage(get, path))) return;
      try {
        const message = await api.stashPaths(
          summary.path,
          summary.headBranch,
          summary.headOid,
          [path],
        );
        await refreshIfCurrent(get, owner);
        toastStashOutcome(message);
      } catch (e) {
        toastWriteError(get, e, () => get().stashFile(path));
      }
    },

    stash: async () => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      if (toastAdvancedGuard(guardedAdvancedWriteMessage(get().changes))) return;
      try {
        const message = await api.stash(summary.path, summary.headBranch, summary.headOid);
        await refreshIfCurrent(get, owner);
        // Routine stash is silent; recovered / partial-cleanup messages still
        // toast so a split state isn't invisible.
        toastStashOutcome(message);
      } catch (e) {
        toastWriteError(get, e, () => get().stash());
      }
    },
  };
}
