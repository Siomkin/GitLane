// Remote read + mutations for the Repository settings → Remotes panel and the
// per-remote account bindings (GL-129). The calls live here so the IPC boundary
// stays in one place — a component never imports `api` to invent a second data
// path (architecture-rules-react.md §1). The read publishes the list into the
// store's `remotes` slice (the panel and account resolution share it) and
// re-resolves the per-remote bindings, since which accounts apply depends on
// the remote list; the mutations stay thin (`git remote add/set-url/remove` via
// the real CLI) and leave the post-write reload + repo `refresh` to the caller,
// which generation-guards them against a repo switch landing mid-await.

import { api } from "@/lib/api";
import { useAccounts } from "./accounts";
import type { RepoGet, RepoSet, RepoState } from "./repoTypes";

export function createRepoRemoteActions(
  set: RepoSet,
  get: RepoGet,
): Pick<RepoState, "listRemotes" | "addRemote" | "setRemoteUrl" | "removeRemote"> {
  // Resolve the open repo's path or throw — the panel only calls these with a
  // repo open, mirroring the `No repository` guard the write actions use.
  const repoPath = (): string => {
    const { summary } = get();
    if (!summary) throw new Error("No repository");
    return summary.path;
  };
  // `async` so the `repoPath()` guard surfaces as a rejected promise, not a
  // synchronous throw — matching every other store action (callers `await` these
  // inside a try/catch).
  return {
    listRemotes: async () => {
      const path = repoPath();
      const remotes = await api.listRemotes(path);
      // Publish only if the same repo is still open — a repo switch landing
      // mid-await must not adopt the previous repo's remote list.
      if (get().summary?.path === path) {
        set({ remotes });
        useAccounts.getState().syncRepoAccount(path);
      }
      return remotes;
    },
    addRemote: async (name, url) => api.addRemote(repoPath(), name, url),
    setRemoteUrl: async (name, url) => api.setRemoteUrl(repoPath(), name, url),
    removeRemote: async (name) => api.removeRemote(repoPath(), name),
  };
}
