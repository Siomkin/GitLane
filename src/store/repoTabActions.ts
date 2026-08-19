// Tab-strip, session, and recents actions for the repo store (GL-158 split out
// of repoLifecycleActions.ts): closing/reordering tabs, restoring the last
// session, and keeping tab labels + the recents list truthful. Opening a repo
// (loadRepo and the missing-repo recovery entry points) stays in
// repoLifecycleActions.ts; these actions delegate to it via `get()`.
//
// The bodies live in focused modules under `repoTab/`; this file is the facade
// that composes them into one action slice.

import { createCloseRepoAction } from "./repoTab/closeRepo";
import { createRecentsActions } from "./repoTab/recents";
import { createRestoreSessionAction } from "./repoTab/restoreSession";
import { createTabStripActions } from "./repoTab/tabStrip";
import { type RepoGet, type RepoSet, type RepoState } from "./repoTypes";

export function createRepoTabActions(
  set: RepoSet,
  get: RepoGet,
): Pick<
  RepoState,
  | "closeRepo"
  | "reorderOpenPaths"
  | "setTabOrder"
  | "restoreSession"
  | "refreshTabInfo"
  | "refreshRecents"
  | "removeRecent"
  | "clearRecents"
> {
  return {
    ...createCloseRepoAction(set, get),
    ...createTabStripActions(set, get),
    ...createRestoreSessionAction(set, get),
    ...createRecentsActions(set, get),
  };
}
