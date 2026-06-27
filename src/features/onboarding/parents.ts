import { useRepo } from "../../store/repo";
import { parentDir } from "./onboarding";

/** Default parent directory for a new clone/init: alongside the most recent repo,
 * so the common case needs no Browse. Empty when there are no recents yet. Read
 * once (as a useState initializer) by the clone and init flows. */
export function defaultParent(): string {
  const recents = useRepo.getState().recents;
  return recents[0] ? parentDir(recents[0].path) : "";
}
