// Worktree writes and the navigation that follows them: creating, removing,
// handing a branch over to another worktree, and switching the tab into one.

import { api } from "@/lib/api";
import { isActiveWorktreePath } from "@/lib/worktrees";
import { openIntent, publishedRepoSession } from "@/store/repoRequests";
import type { RepoGet, RepoSet, RepoState } from "@/store/repoTypes";
import {
  captureFileSelection,
  captureOwner,
  fileSelectionIsCurrent,
  ownerIsCurrent,
  ownerMayNavigate,
  releaseLoadingIfCurrent,
  runOp,
  type RepoWriteOwner,
} from "./shared";

export function createWorktreeActions(
  set: RepoSet,
  get: RepoGet,
): Pick<
  RepoState,
  | "removeWorktree"
  | "previewRemoveWorktree"
  | "moveBranchToWorktree"
  | "createWorktreeAt"
  | "openWorktree"
> {
  return {
    removeWorktree: (worktreePath, expectedState) =>
      runOp(get, async (summary) =>
        api.removeWorktree(summary.path, worktreePath, expectedState),
      ),

    previewRemoveWorktree: (worktreePath) => {
      const { summary } = get();
      if (!summary) return Promise.reject(new Error("No repository"));
      return api.previewRemoveWorktree(summary.path, worktreePath);
    },

    moveBranchToWorktree: async (branch, fromWorktreePath, toWorktreePath, carry) => {
      const { summary, loading } = get();
      if (!summary) throw new Error("No repository");
      const owner = captureOwner(summary);
      // Guard against a double-submit: the handoff (stash → detach → checkout →
      // pop) is slow and the IPC runs before loadRepo raises `loading`, so a second
      // trigger could launch a concurrent move on the shared stash. Hold `loading`
      // across the IPC ourselves; loadRepo takes it over on success.
      if (loading) throw new Error("Another operation is in progress");
      set({ loading: true, error: null });
      try {
        const message = await api.moveBranchToWorktree(
          summary.path,
          branch,
          fromWorktreePath,
          toWorktreePath,
          carry,
        );
        // The dialog can be dismissed mid-move and the tab(s) closed while the
        // move finishes in the background — landing on the destination then
        // would yank the app off the welcome screen the user chose. When every
        // tab is gone, `useHandoffRun` toasts the outcome so it isn't lost
        // (GL-105); with a tab still open the destination load is the signal.
        if (!ownerMayNavigate(get, owner) || get().openPaths.length === 0) return message;
        // Land on the destination — the branch (and any carried work, or a
        // conflict to resolve) lives there now. loadRepo owns the loading lifecycle
        // + open intent, republishes the graph, and reads operation_status, so a
        // carry conflict opens the conflict workspace for the destination. The
        // landing switches the current tab in place — same repository, same
        // tab (GL-110) — rather than opening the destination as a sibling.
        // Release this operation's spinner before `loadRepo` synchronously
        // claims the navigation intent and takes over its own loading lifecycle.
        releaseLoadingIfCurrent(set, get, owner);
        await get().loadRepo(toWorktreePath, { replaceTab: summary.path });
        return message;
      } catch (e) {
        releaseLoadingIfCurrent(set, get, owner, true);
        throw e;
      } finally {
        // Safety net: on success loadRepo already cleared `loading`; if it didn't
        // (IPC threw, or loadRepo failed to open the destination) don't strand the
        // spinner.
        if (get().loading) releaseLoadingIfCurrent(set, get, owner);
      }
    },

    createWorktreeAt: async (worktreePath, reference, newBranch) => {
      const { summary } = get();
      if (!summary) throw new Error("No repository");
      const owner = captureOwner(summary);
      // Create the worktree against the current repo, then open the new path as
      // its own repo tab (loadRepo discovers + watches it). With `newBranch`,
      // `reference` is the new branch's start point.
      await api.addWorktree(summary.path, worktreePath, reference, newBranch);
      if (ownerMayNavigate(get, owner)) await get().loadRepo(worktreePath);
      return newBranch
        ? `Created ${newBranch} in a worktree at ${worktreePath}`
        : `Created worktree at ${worktreePath}`;
    },

    openWorktree: async (worktreePath, opts) => {
      // In-place by default (GL-110): git's model is one repository, many
      // working trees, so switching worktrees moves the *current tab* to the
      // new path — it keeps the repository identity — instead of opening a
      // sibling tab. `newTab` is the explicit side-by-side action; a worktree
      // already open in another tab is simply activated (loadRepo's
      // includes-check leaves the strip untouched either way).
      const currentPath = get().summary?.path;
      const previousPublishedSession = publishedRepoSession.current();
      const load = get().loadRepo(
        worktreePath,
        opts?.newTab || !currentPath ? undefined : { replaceTab: currentPath },
      );
      // loadRepo claims its intent synchronously before its first await. Retain
      // that exact claim so a later A -> B -> A navigation cannot revive this
      // worktree switch's automatic WIP/HEAD selection on the reopened A.
      const loadIntent = openIntent.current();
      await load;
      // Ownership guard: loadRepo absorbs failures and can be superseded by a
      // newer open, so the post-load work below must only run when the
      // requested worktree actually became the active repo — never against
      // whichever repo is still (or newly) on screen.
      if (
        !openIntent.isCurrent(loadIntent) ||
        publishedRepoSession.current() === previousPublishedSession ||
        !isActiveWorktreePath(get().summary, worktreePath)
      ) {
        return;
      }
      const summary = get().summary;
      if (!summary) return;
      const owner: RepoWriteOwner = {
        path: summary.path,
        openIntent: loadIntent,
        publishedSession: publishedRepoSession.current(),
      };
      // A reveal already pending here is a during-load pick (GL-20): the user
      // navigated somewhere deliberate while the graph skeleton was up, and
      // loadRepo honored it — the HEAD reveal below must not clobber it. The
      // selection snapshot catches the same intent expressed as a plain graph
      // click during the status await (a click sets no revealTarget).
      const duringLoadPick = get().revealTarget !== null;
      const parkedSelection = get().selectedCommit;
      const parkedFileSelection = captureFileSelection(get);
      // Switching into a worktree is usually about its in-progress work. If the
      // freshly loaded worktree is dirty, surface its working tree (the WIP
      // node, always the top row) so the uncommitted files are visible
      // immediately instead of hidden behind a commit diff. Best-effort and
      // guarded against a repo switch landing between the load and the select.
      try {
        const changes = await api.workingChanges(summary.path);
        const dirty =
          changes.staged.length > 0 ||
          changes.unstaged.length > 0 ||
          changes.conflicted.length > 0;
        if (dirty && ownerIsCurrent(get, owner)) {
          set({ changes });
          // The same user-signal rule as the clean HEAD reveal below: a
          // during-load pick or a selection made while the status read was in
          // flight is deliberate navigation — don't yank it to the WIP node.
          if (
            !duringLoadPick &&
            ownerMayNavigate(get, owner) &&
            get().revealTarget === null &&
            get().selectedCommit === parkedSelection &&
            fileSelectionIsCurrent(get, parkedFileSelection)
          ) {
            get().selectWip();
          }
          return;
        }
      } catch {
        // The dirty state is unknown — revealing HEAD could yank a dirty
        // worktree away from its working tree, so keep loadRepo's default
        // selection instead.
        return;
      }
      // Clean worktree: land the graph on its HEAD row (the branch tip, or the
      // detached commit). loadRepo clears the selection and leaves the list at
      // the top, so without this the switch arrives "nowhere" — the commit the
      // worktree sits on is neither selected nor scrolled into view (it may not
      // even be inside the initially loaded window). The reveal stays pending
      // until the graph mounts and pages in more history when the row is deeper.
      // The graph is interactive during the status await, so every user signal
      // wins over the automatic reveal: a pending revealTarget (before or after
      // the await) and any selection change since the snapshot both bail.
      if (!ownerMayNavigate(get, owner) || duringLoadPick || get().revealTarget !== null) return;
      if (get().selectedCommit !== parkedSelection) return;
      if (!fileSelectionIsCurrent(get, parkedFileSelection)) return;
      // HEAD is re-read from the live summary: a same-path refresh during the
      // status read can move it, and the reveal should land on where HEAD is
      // now, not where it was before the await.
      const live = get().summary;
      if (!ownerMayNavigate(get, owner) || live?.path !== summary.path || !live.headOid) return;
      // Already parked on the HEAD row (a tip-aligned worktree): re-revealing
      // would only re-fetch its files and flash a row the user is looking at.
      if (get().selectedCommit === live.headOid) return;
      await get().revealCommit(live.headOid);
    },
  };
}
