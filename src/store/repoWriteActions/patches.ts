// Patch writes keep their toast: the generated, collision-safe filename
// ("0001-<subject>-2.patch") is the whole result and no view renders it, so
// silence would leave the user with no idea what was written or where.

import { api } from "@/lib/api";
import { useUi } from "@/store/ui";
import type { RepoGet, RepoState } from "@/store/repoTypes";
import { runOp, toastOutcome } from "./shared";

export function createPatchActions(
  get: RepoGet,
): Pick<RepoState, "createPatchAt" | "createPatchRangeAt" | "createWorkingTreePatch"> {
  return {
    createPatchAt: (sha) =>
      runOp(get, async (summary) => {
        const file = await api.createPatch(summary.path, sha);
        return toastOutcome(`Created patch ${file}`);
      }),

    createPatchRangeAt: (base, head) =>
      runOp(get, async (summary) => {
        const file = await api.createPatchRange(summary.path, base, head);
        return toastOutcome(`Created patch ${file}`);
      }),

    createWorkingTreePatch: async (path) => {
      const { summary } = get();
      if (!summary) return "";
      try {
        const file = await api.createWorkingTreePatch(summary.path, path);
        // The sole caller discards the return (`void createWorkingTreePatch`),
        // so the generated filename only reaches the user as a toast.
        toastOutcome(`Wrote ${file}`);
        return file;
      } catch (e) {
        useUi.getState().showToast(String(e), "error");
        return "";
      }
    },
  };
}
