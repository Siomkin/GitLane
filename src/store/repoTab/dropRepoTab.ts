// Dropping a repo tab from the strip (close, in-place worktree switch, removed
// worktree retirement/fallback, Locate… re-key): release everything the tab
// holds outside the repo store's own tab state.

import { endTabLifetime } from "@/store/repoRequests";
import { unwatchRepo } from "@/store/repoWatchQueue";
import { useTerminals } from "@/store/terminals";
import { useUi } from "@/store/ui";

/**
 * End `path`'s tab lifetime, release its filesystem watch, and close its
 * terminals. The panes manager disposes a PTY only when its tab leaves
 * `useTerminals.byRepo`, so a drop path that skips this leaves shells running
 * with no UI. Store state (`openPaths`, tab info, recents, persistence) differs
 * per caller and stays with it. Call it only once the tab has truly left.
 */
export function dropRepoTab(path: string): void {
  // Before any persisted/UI mutation, so a pending activation or label probe
  // cannot publish into a same-path reopen.
  endTabLifetime(path);
  // Sequenced per path so an immediate reopen's watch can't be reordered ahead
  // of this unwatch (GL-125).
  void unwatchRepo(path);
  useTerminals.getState().closeRepoTerminals(path);
  useUi.getState().forgetTerminalView(path);
}
