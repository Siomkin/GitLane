import { isRemoteLocator } from "@/lib/paths";
import { useRepo } from "@/store/repo";

/** Why a feature is off for a repository opened over SSH (remote-ssh-repos):
 * it acts on this computer — a terminal, the file manager, an app, an agent, a
 * forge session — or writes files the remote view keeps read-only. */
export const REMOTE_UNAVAILABLE = "Unavailable for remote repositories";

/** Whether the active repository is opened over SSH. */
export const useIsRemoteRepo = () =>
  useRepo((state) => !!state.summary && isRemoteLocator(state.summary.path));

/** The same, read once (shortcut handlers, store actions). */
export const isRemoteRepoNow = () => {
  const path = useRepo.getState().summary?.path;
  return !!path && isRemoteLocator(path);
};
