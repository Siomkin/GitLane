// Checking a branch, a remote branch, or a bare commit out into the working
// tree — including the "that branch lives in another worktree" hand-off dialog.

import { api, type RepoSummary } from "@/lib/api";
import { trimTrailingSeparators } from "@/lib/paths";
import { worktreeName } from "@/lib/worktrees";
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
  type RepoWriteOwner,
} from "./shared";
import {
  runPendingCheckout,
  TITLES,
  withCheckoutFeedback,
  type CheckoutFeedbackMode,
} from "./checkoutFeedback";

export function createCheckoutActions(
  set: RepoSet,
  get: RepoGet,
): Pick<RepoState, "checkoutBranch" | "checkoutRemoteBranch" | "checkoutDetached"> {
  /** Run a checkout as the repo's one pending checkout, keyed by `ref`. */
  const pending = (
    ref: string,
    label: () => string,
    body: (summary: RepoSummary, owner: RepoWriteOwner) => Promise<string>,
  ) => {
    const { summary } = get();
    if (!summary) return Promise.reject(new Error("No repository"));
    const owner = captureOwner(summary);
    return runPendingCheckout(
      set,
      get,
      { ref, label, repoPath: summary.path, isCurrent: () => ownerIsCurrent(get, owner) },
      () => body(summary, owner),
    );
  };

  return {
    checkoutBranch: (name) =>
      pending(name, () => `${TITLES.checkout.busy} ${name}`, (summary, owner) =>
        checkoutBranchBody(name, summary, owner),
      ),

    checkoutRemoteBranch: (remote, branch) => {
      // Becomes "update" once the probe finds the branch in another worktree.
      const feedback = { mode: "checkout" as CheckoutFeedbackMode };
      return pending(
        `${remote}/${branch}`,
        () => `${TITLES[feedback.mode].busy} ${branch}`,
        (summary, owner) => checkoutRemoteBranchBody(remote, branch, summary, owner, feedback),
      );
    },

    checkoutDetached: (sha) => {
      const short = sha.slice(0, 7);
      return pending(sha, () => `${TITLES.checkout.busy} ${short}`, () =>
        runOp(get, async (summary, owner) => {
          await withCheckoutFeedback(short, () => api.checkout(summary.path, sha, true), {
            repoPath: owner.path,
            isCurrent: () => ownerIsCurrent(get, owner),
            progress: false,
          });
          return `Checked out ${short} (detached)`;
        }),
      );
    },
  };

  async function checkoutBranchBody(
    name: string,
    summary: RepoSummary,
    owner: RepoWriteOwner,
  ): Promise<string> {
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
        (wt) => trimTrailingSeparators(wt.path) === trimTrailingSeparators(existingWorktree.path),
      );
      const here = handoffDestinationHere(
        worktrees,
        existingWorktree.path,
        summary.workdir ?? summary.path,
      );
      if (holder && here && handoffSourceValid(worktrees, holder.path)) {
        const ui = useUi.getState();
        ui.requestConfirm({
          title: "Branch is in another worktree",
          message: `Git checks a branch out in only one worktree at a time; this one is in "${worktreeName(holder, worktrees)}".`,
          icon: "worktree",
          facts: [
            { label: "Branch", value: name, kind: "ref" },
            { label: "Worktree", value: holder.path, kind: "path" },
          ],
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
              (wt) => trimTrailingSeparators(wt.path) === trimTrailingSeparators(holder.path),
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
      // A dirty editor puts a discard dialog in front of the switch.
      const landing = ownerMayNavigate(get, owner)
        ? await get().openWorktree(existingWorktree.path)
        : undefined;
      return landing === "deferred" ? "" : `Opened ${name} worktree`;
    }
    set({ loading: true, error: null });
    try {
      await withCheckoutFeedback(name, () => api.checkout(summary.path, name, false), {
        repoPath: owner.path,
        isCurrent: () => ownerIsCurrent(get, owner),
        progress: false,
      });
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
  }

  async function checkoutRemoteBranchBody(
    remote: string,
    branch: string,
    summary: RepoSummary,
    owner: RepoWriteOwner,
    feedback: { mode: CheckoutFeedbackMode },
  ): Promise<string> {
    const existingWorktree = await findCheckoutWorktree(set, get, summary, owner, branch);
    if (existingWorktree) feedback.mode = "update";
    if (!ownerMayNavigate(get, owner)) {
      throw new Error("Repository changed while checking worktrees. Try again.");
    }
    set({ loading: true, error: null });
    try {
      // A branch already owned by another worktree must be advanced there:
      // opening it without running the remote checkout would leave the local
      // branch behind the remote ref the user explicitly selected.
      const checkoutPath = existingWorktree?.path ?? summary.path;
      // In another worktree the branch is updated in place, not checked out.
      await withCheckoutFeedback(
        branch,
        () => api.checkoutRemoteBranch(checkoutPath, remote, branch),
        {
          mode: feedback.mode,
          repoPath: owner.path,
          isCurrent: () => ownerIsCurrent(get, owner),
          progress: false,
        },
      );
      releaseLoadingIfCurrent(set, get, owner);
      if (existingWorktree) {
        const landing = ownerMayNavigate(get, owner)
          ? await get().openWorktree(existingWorktree.path)
          : undefined;
        return landing === "deferred"
          ? `Updated ${branch}`
          : `Updated ${branch} and opened its worktree`;
      }
      await refreshIfCurrent(get, owner);
      return `Checked out ${branch}`;
    } catch (e) {
      releaseLoadingIfCurrent(set, get, owner);
      // The backend moves a branch that isn't checked out before switching
      // to it, so a switch refused by dirty changes still leaves that branch
      // advanced; refresh before surfacing the error so the branch list
      // never waits on the watcher to become truthful.
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
  }
}
