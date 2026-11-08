// The user's ways out of the file editor, each asking before it drops a dirty
// draft. UI calls these; the store's own callers (a vanished repo, reselecting
// after a load) use the raw actions, because nobody chose to leave.

import { useRepo } from "./repo";
import type { RepoState } from "./repoTypes";

type ExitAction =
  | "selectFile"
  | "selectCommitMulti"
  | "selectWip"
  | "returnToGraph"
  | "revealCommit"
  | "revealStash"
  | "openCompare"
  | "openFileHistory"
  | "loadRepo"
  | "closeRepo";

/** Async only so callers can await a clean-state exit; the guard itself runs
 * synchronously, so `loadRepo` still claims its open intent before this yields. */
const guarded =
  <K extends ExitAction>(action: K) =>
  async (...args: Parameters<RepoState[K]>): Promise<void> => {
    const state = useRepo.getState();
    const exit = state[action] as (...exitArgs: Parameters<RepoState[K]>) => unknown;
    await state.guardDirtyFileView(() => exit(...args));
  };

export const selectFileGuarded = guarded("selectFile");
export const selectCommitMultiGuarded = guarded("selectCommitMulti");
export const selectWipGuarded = guarded("selectWip");
export const returnToGraphGuarded = guarded("returnToGraph");
export const revealCommitGuarded = guarded("revealCommit");
export const revealStashGuarded = guarded("revealStash");
export const openCompareGuarded = guarded("openCompare");
export const openFileHistoryGuarded = guarded("openFileHistory");
export const loadRepoGuarded = guarded("loadRepo");

const closeActiveRepo = guarded("closeRepo");

/** Only the active tab holds the editor, so a background tab closes unprompted. */
export const closeRepoGuarded = (path: string): Promise<void> =>
  useRepo.getState().summary?.path === path
    ? closeActiveRepo(path)
    : useRepo.getState().closeRepo(path);
