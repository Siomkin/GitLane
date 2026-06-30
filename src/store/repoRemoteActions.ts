// Remote read + mutations for the Repository settings → Remotes panel. The panel
// is the only consumer today, but the calls live here so the IPC boundary stays
// in one place — a component never imports `api` to invent a second data path
// (architecture-rules-react.md §1). The read returns the list for the panel's
// local view state; the mutations stay thin (`git remote add/set-url/remove` via
// the real CLI) and leave the post-write reload + repo `refresh` to the caller,
// which generation-guards them against a repo switch landing mid-await.

import { api } from "../lib/api";
import type { RepoGet, RepoSet, RepoState } from "./repoTypes";

export function createRepoRemoteActions(
  _set: RepoSet,
  get: RepoGet,
): Pick<RepoState, "listRemotes" | "addRemote" | "setRemoteUrl" | "removeRemote"> {
  // Resolve the open repo's path or throw — the panel only calls these with a
  // repo open, mirroring the `No repository` guard the write actions use.
  const repoPath = (): string => {
    const { summary } = get();
    if (!summary) throw new Error("No repository");
    return summary.path;
  };
  return {
    listRemotes: () => api.listRemotes(repoPath()),
    addRemote: (name, url) => api.addRemote(repoPath(), name, url),
    setRemoteUrl: (name, url) => api.setRemoteUrl(repoPath(), name, url),
    removeRemote: (name) => api.removeRemote(repoPath(), name),
  };
}
