// Checking a branch, a remote branch, or a bare commit out into the working
// tree — including the "that branch lives in another worktree" hand-off dialog.

import { api } from "@/lib/api";
import { trimTrailingSlash, worktreeName } from "@/lib/worktrees";
import {
  handoffDestinationHere,
  handoffSourceValid,
  startWorktreeHandoff,
} from "@/lib/worktreeHandoff";
import { flushPendingRefresh } from "@/store/repoGuards";
import { useUi } from "@/store/ui";
import type { RepoGet, RepoSet, RepoState } from "@/store/repoTypes";
import {
  captureOwner,
  findCheckoutWorktree,
  ownerIsCurrent,
  ownerMayNavigate,
  refreshIfCurrent,
  releaseLoadingIfCurrent,
  runOp,
} from "./shared";

export function createCheckoutActions(
  set: RepoSet,
  get: RepoGet,
): Pick<RepoState, "checkoutBranch" | "checkoutRemoteBranch" | "checkoutDetached"> {
  return {
    checkoutBranch: async (name) => {
      const { summary } = get();
      if (!summary) throw new Error("No repository");
      const owner = captureOwner(summary);
      const existingWorktree = await findCheckoutWorktree(set, get, summary, owner, name);
      // findCheckoutWorktree guards its own probe path, but the cached path
      // resolves without that check — re-verify ownership after the await so a
      // concurrent tab switch can't pair this repo's dialog with another's state.
      if (!ownerMayNavigate(get, owner)) {
        throw new Error("Repository changed while checking worktrees. Try again.");
      }
      if (existingWorktree) {
        // Git refuses to check a branch out in two worktrees, so this checkout
        // can't proceed as-is. Don't silently switch the tab into the holding
        // worktree (it may be a foreign agent scratch checkout the user never
        // wants to enter) — name that worktree and ask: reclaim the branch here
        // (the hand-off flow, destination preselected) or open it there. Falls
        // back to the plain open when the reclaim isn't possible (the holder is
        // prunable, or the open worktree isn't a valid destination).
        const worktrees = get().worktrees;
        const holder = worktrees.find(
          (wt) => trimTrailingSlash(wt.path) === trimTrailingSlash(existingWorktree.path),
        );
        const here = handoffDestinationHere(
          worktrees,
          existingWorktree.path,
          summary.workdir ?? summary.path,
        );
        if (holder && here && handoffSourceValid(worktrees, holder.path)) {
          const ui = useUi.getState();
          ui.requestConfirm({
            title: `${name} is in another worktree`,
            message: `Git allows a branch to be checked out in only one worktree at a time, and ${name} is currently checked out in "${worktreeName(holder, worktrees)}".`,
            details: [holder.path],
            confirmLabel: "Check out here",
            onConfirm: () => {
              // The confirm can sit open while a watcher refresh prunes the
              // holder, moves the branch, or invalidates the destination — the
              // snapshot above is only what the dialog was opened FROM. Re-gate
              // against the live list before starting the multi-step move (the
              // backend also fails closed, but this keeps the error immediate
              // and readable instead of a mid-handoff failure).
              const liveWorktrees = get().worktrees;
              const liveSummary = get().summary;
              const liveHolder = liveWorktrees.find(
                (wt) => trimTrailingSlash(wt.path) === trimTrailingSlash(holder.path),
              );
              const liveHere =
                liveSummary &&
                handoffDestinationHere(
                  liveWorktrees,
                  holder.path,
                  liveSummary.workdir ?? liveSummary.path,
                );
              if (
                !ownerMayNavigate(get, owner) ||
                liveSummary?.path !== summary.path ||
                liveHolder?.branch !== name ||
                !liveHere ||
                !handoffSourceValid(liveWorktrees, liveHolder.path)
              ) {
                useUi
                  .getState()
                  .showToast(`${name} moved while the dialog was open. Try again.`, "error");
                return;
              }
              startWorktreeHandoff({
                branch: name,
                sourcePath: liveHolder.path,
                worktrees: liveWorktrees,
                // The holder isn't the open repo, so its dirtiness is unknown
                // here — the dialog phrases the carry conditionally.
                sourceChanges: null,
                destPath: liveHere.value,
                openHandoff: useUi.getState().openHandoff,
                onNoDestinations: () =>
                  useUi.getState().showToast("No worktree to check out into.", "error"),
              });
            },
            secondary: {
              label: "Open that worktree",
              onClick: () => {
                if (!ownerMayNavigate(get, owner)) return;
                void get()
                  .openWorktree(holder.path)
                  .catch((e) => useUi.getState().showToast(e, "error"));
              },
            },
          });
          // The dialog owns what happens next — nothing to toast.
          return "";
        }
        if (ownerMayNavigate(get, owner)) await get().openWorktree(existingWorktree.path);
        return `Opened ${name} worktree`;
      }
      set({ loading: true, error: null });
      try {
        await api.checkout(summary.path, name, false);
        releaseLoadingIfCurrent(set, get, owner);
        await refreshIfCurrent(get, owner);
        return `Checked out ${name}`;
      } catch (e) {
        // Reset the spinner but let the caller present the failure (toast), so a
        // failed checkout never leaves a stale success message behind. Replay any
        // re-sync deferred while this op held `loading` (GL-20 review).
        releaseLoadingIfCurrent(set, get, owner, true);
        throw e;
      }
    },

    checkoutRemoteBranch: async (remote, branch) => {
      const { summary } = get();
      if (!summary) throw new Error("No repository");
      const owner = captureOwner(summary);
      const existingWorktree = await findCheckoutWorktree(set, get, summary, owner, branch);
      if (!ownerMayNavigate(get, owner)) {
        throw new Error("Repository changed while checking worktrees. Try again.");
      }
      set({ loading: true, error: null });
      try {
        // A branch already owned by another worktree must be advanced there:
        // opening it without running the remote checkout would leave the local
        // branch behind the remote ref the user explicitly selected.
        const checkoutPath = existingWorktree?.path ?? summary.path;
        await api.checkoutRemoteBranch(checkoutPath, remote, branch);
        releaseLoadingIfCurrent(set, get, owner);
        if (existingWorktree) {
          if (ownerMayNavigate(get, owner)) await get().openWorktree(existingWorktree.path);
          return `Updated ${branch} and opened its worktree`;
        }
        await refreshIfCurrent(get, owner);
        return `Checked out ${branch}`;
      } catch (e) {
        releaseLoadingIfCurrent(set, get, owner);
        // Checkout and `merge --ff-only` are separate git commands. The
        // backend reports when checkout succeeded but dirty changes blocked
        // the merge; refresh before surfacing that partial outcome so HEAD and
        // the working tree never wait on the watcher to become truthful.
        if (ownerIsCurrent(get, owner)) {
          try {
            await refreshIfCurrent(get, owner);
          } catch {
            // Preserve the operation's actionable error if the recovery read
            // also fails; the watcher can still retry the refresh later.
          }
        }
        if (ownerIsCurrent(get, owner)) flushPendingRefresh(get);
        throw e;
      }
    },

    checkoutDetached: (sha) =>
      runOp(get, async (summary) => {
        await api.checkout(summary.path, sha, true);
        return `Checked out ${sha.slice(0, 7)} (detached)`;
      }),
  };
}
