import { isRemoteLocator } from "@/lib/paths";
import { useRepo } from "@/store/repo";

export { REMOTE_UNAVAILABLE } from "@/lib/paths";

/** Whether the active repository is opened over SSH. */
export const useIsRemoteRepo = () =>
  useRepo((state) => !!state.summary && isRemoteLocator(state.summary.path));

/** The same, read once (shortcut handlers, store actions). */
export const isRemoteRepoNow = () => {
  const path = useRepo.getState().summary?.path;
  return !!path && isRemoteLocator(path);
};
