// Every PR write: review-thread replies/resolves, merge (including a whole
// stack), comment, review, state changes, and creating a pull request — plus
// the shared runner they all go through, which pins the write to the repo and
// account that started it and tracks it in the pending-action multiset.

import {
  api,
  type GithubAccountRef,
  type PrStateAction,
  type ReviewAction,
} from "@/lib/api";
import { useAccounts } from "@/store/accounts";
import { useNotifications } from "@/store/notifications";
import type { PullsGet, PullsState } from "@/store/pulls";
import { usePulls } from "@/store/pulls";
import {
  capturePrActionContext,
  prActionOwnerIsCurrent,
  type PrActionOwner,
} from "@/store/pullsActionOwner";
import { useRepo } from "@/store/repo";

let nextPrPendingActionId = 1;

/** Store-level write categories. These are coarser than `PR_ACTION_KEY`: the
 * store coordinates domain writes, while components distinguish button labels. */
export const PR_PENDING_ACTION = {
  Merge: "merge",
  /** Distinct from `Merge`: a stack merge lands several PRs, and the stack card
   * describes it that way. Sharing one kind would make a plain single-PR merge
   * on a stacked PR claim "Merging stack… / N pull requests are being merged". */
  MergeStack: "merge-stack",
  Comment: "comment",
  Review: "review",
  State: "state",
  Create: "create",
} as const;

export type PrPendingActionKind = (typeof PR_PENDING_ACTION)[keyof typeof PR_PENDING_ACTION];

export interface PrPendingAction {
  id: number;
  action: PrPendingActionKind;
  /** The affected PR, or null for create (which has no PR number yet). */
  prNum: number | null;
  /** Exact lifecycle verb when `action` is `State`. */
  stateAction?: PrStateAction;
  /** Exact review verb when `action` is `Review`. */
  reviewAction?: ReviewAction;
}

/** Selector factory: "is this action (on this PR) in flight?" — one definition
 * instead of every caller re-writing the `.some()` predicate inline. The
 * returned selector produces a boolean, so Zustand's default (Object.is)
 * equality holds: a fresh closure per render just re-runs the predicate and
 * re-renders only when the boolean flips — no new subscription shape.
 *
 * `prNum` omitted → any PR (or no PR — create files `prNum: null`).
 * `verbs` narrows State/Review entries to the exact lifecycle/review verb a
 * specific button reports (e.g. only an "approve" review, not a comment
 * review on the same PR). */
export function isPrActionPending(
  action: PrPendingActionKind,
  prNum?: number,
  verbs?: { stateAction?: PrStateAction; reviewAction?: ReviewAction },
): (s: PullsState) => boolean {
  return (s) =>
    s.prPendingActions.some(
      (pending) =>
        pending.action === action &&
        (prNum === undefined || pending.prNum === prNum) &&
        (!verbs?.stateAction || pending.stateAction === verbs.stateAction) &&
        (!verbs?.reviewAction || pending.reviewAction === verbs.reviewAction),
    );
}

/** Selector factory: "is ANY PR write in flight?" — the global disable the
 * write controls share so a second action can't start mid-write. */
export function anyPrActionPending(): (s: PullsState) => boolean {
  return (s) => s.prPendingActions.length > 0;
}

export function createPrWriteActions(
  get: PullsGet,
): Pick<
  PullsState,
  | "resolveThread"
  | "replyThread"
  | "mergePr"
  | "mergeStack"
  | "commentPr"
  | "reviewPr"
  | "setPrState"
  | "createPr"
  | "loadReviewerCandidates"
> {
  return {
    resolveThread: async (num, threadId, resolved) => {
      const { output, owner } = await runPrAction(
        (path, account) => api.resolveReviewThread(path, num, threadId, resolved, account),
        { trackPending: false },
      );
      await runPrActionFollowUp(owner, () => get().loadPrThreads(num, true));
      return output;
    },

    replyThread: async (num, threadId, body) => {
      const { output, owner } = await runPrAction(
        (path, account) => api.replyReviewThread(path, num, threadId, body, account),
        { trackPending: false },
      );
      await runPrActionFollowUp(owner, () => get().loadPrThreads(num, true));
      return output;
    },

    mergePr: async (num, method, deleteBranch) => {
      const { output, owner } = await runPrAction(
        (path, account) => api.mergePullRequest(path, num, method, deleteBranch, account),
        { action: PR_PENDING_ACTION.Merge, prNum: num },
      );
      // The merge itself is routine success and stays silent — the PR list already
      // updates. Nothing surfaces that a requested branch *deletion* failed, so
      // that is toasted here rather than in the shared (provider-neutral) PR action
      // runner (GL-345). Gated on ownership like every other write result: the user
      // can switch repo or account while the merge and its probe are in flight, and
      // a stale "Merged #7…" must not land in the newly opened context.
      if (output.undeletedBranch && prActionOwnerIsCurrent(owner)) {
        useNotifications.getState().notify({
          kind: "warning",
          title: `Merged #${num}, but ${output.undeletedBranch} was not deleted`,
          body: "The branch may be protected, or the account may lack permission to delete it.",
        });
      }
      // State + checked-out branch can both change; reload the list and this PR.
      // Nothing consumes the returned string (the shared runner only checks that
      // the promise resolved), so the outcome is reported above, not returned.
      if (!(await runPrActionFollowUp(owner, () => get().loadPullRequests(true)))) return "";
      if (!(await runPrActionFollowUp(owner, () => get().loadPrDetail(num, true)))) return "";
      if (prActionOwnerIsCurrent(owner)) {
        void useRepo.getState().refresh({ prs: false });
      }
      return "";
    },

    mergeStack: async (num, method) => {
      const { output, owner } = await runPrAction(
        (path, account) => api.mergePullRequestStack(path, num, method, account),
        { action: PR_PENDING_ACTION.MergeStack, prNum: num },
      );
      // A stack merge lands several PRs at once, so the whole list is stale — not
      // just this one. Same follow-up as `mergePr` otherwise.
      if (!(await runPrActionFollowUp(owner, () => get().loadPullRequests(true)))) return output;
      if (!(await runPrActionFollowUp(owner, () => get().loadPrDetail(num, true)))) return output;
      if (prActionOwnerIsCurrent(owner)) {
        void useRepo.getState().refresh({ prs: false });
      }
      return output;
    },

    commentPr: async (num, body) => {
      const { output, owner } = await runPrAction(
        (path, account) => api.commentPullRequest(path, num, body, account),
        { action: PR_PENDING_ACTION.Comment, prNum: num },
      );
      await runPrActionFollowUp(owner, () => get().loadPrDetail(num, true));
      return output;
    },

    reviewPr: async (num, action, body) => {
      const { output, owner } = await runPrAction(
        (path, account) => api.reviewPullRequest(path, num, action, body, account),
        { action: PR_PENDING_ACTION.Review, prNum: num, reviewAction: action },
      );
      if (!(await runPrActionFollowUp(owner, () => get().loadPrDetail(num, true)))) return output;
      if (prActionOwnerIsCurrent(owner)) {
        void get().loadPrChecks(num, true);
      }
      return output;
    },

    setPrState: async (num, action) => {
      const { output, owner } = await runPrAction(
        (path, account) => api.setPullRequestState(path, num, action, account),
        { action: PR_PENDING_ACTION.State, prNum: num, stateAction: action },
      );
      if (!(await runPrActionFollowUp(owner, () => get().loadPullRequests(true)))) return output;
      await runPrActionFollowUp(owner, () => get().loadPrDetail(num, true));
      return output;
    },

    createPr: async (input, stackBelow) => {
      const { output, owner } = await runPrAction(
        (path, account) => api.createPullRequest(path, input, account),
        { action: PR_PENDING_ACTION.Create, prNum: null },
      );
      // Linking is deliberately not folded into the create: the pull request
      // exists once `gh pr create` returns, so a link failure must read as
      // "opened but not linked" rather than failing the whole action.
      const created = prNumberFromUrl(output);
      if (stackBelow?.length && created !== null) {
        // Linking targets the repo/account the create ran against — `owner`, not
        // whatever is open now. If either changed mid-flight the link cannot run
        // at all (the current account may not even reach that repo), and that is
        // reported like any other link failure: the PR exists, it is not linked.
        const stale = !prActionOwnerIsCurrent(owner);
        try {
          if (stale) {
            throw new Error("The repository or account changed while the pull request was opening.");
          }
          await api.linkPullRequestStack(
            owner.path,
            [...stackBelow, created],
            useAccounts.getState().prAccountRef(),
          );
        } catch (e) {
          useNotifications.getState().notify({
            kind: "warning",
            title: "Pull request opened, but the stack was not linked",
            body: String(e),
          });
        }
      }
      await runPrActionFollowUp(owner, () => get().loadPullRequests(true));
      return output;
    },

    loadReviewerCandidates: async () => {
      const path = useRepo.getState().summary?.path;
      if (!path) return [];
      try {
        return await api.pullRequestReviewerCandidates(path, useAccounts.getState().prAccountRef());
      } catch {
        // Reviewers are optional garnish on the create form. A provider that has
        // no lookup, or a token without the scope for one, must not stop someone
        // opening a pull request.
        return [];
      }
    },
  };
}

/** The number in a pull request URL's trailing `/pull/<n>` segment. */
function prNumberFromUrl(url: string): number | null {
  const match = /\/pull\/(\d+)/.exec(url.trim());
  return match ? Number(match[1]) : null;
}

// Shared body for PR write ops: require an open repo, run the call pinned to the
// bound account, and surface gh's output. Rejects (for the caller to toast) when
// there's no repo or gh errors. `trackPending` toggles the global PR action flag;
// review-thread actions pass `false` because they render inside independent cards
// and own their pending state locally (one busy thread must not disable the rest).
async function runPrAction<T = string>(
  body: (path: string, account: GithubAccountRef | null) => Promise<T>,
  {
    action,
    prNum = null,
    stateAction,
    reviewAction,
    trackPending = true,
  }: {
    action?: PrPendingActionKind;
    prNum?: number | null;
    stateAction?: PrStateAction;
    reviewAction?: ReviewAction;
    trackPending?: boolean;
  } = {},
): Promise<{ output: T; owner: PrActionOwner }> {
  const context = capturePrActionContext();
  if (!context) throw new Error("No repository");
  const { owner, account } = context;
  if (!trackPending || !action) {
    return { output: await body(owner.path, account), owner };
  }
  // Write errors surface via the caller's toast, not `prError` (which is the
  // list-load error and must not be cleared/clobbered by a write op). Track the
  // action in a multiset so concurrent writes are independent: one finishing
  // removes only its own entry, never clearing another action's busy state.
  const pendingEntry: PrPendingAction = {
    id: nextPrPendingActionId++,
    action,
    prNum,
    ...(stateAction ? { stateAction } : {}),
    ...(reviewAction ? { reviewAction } : {}),
  };
  usePulls.setState((s) => ({ prPendingActions: [...s.prPendingActions, pendingEntry] }));
  try {
    return { output: await body(owner.path, account), owner };
  } finally {
    usePulls.setState((s) => {
      const i = s.prPendingActions.findIndex((pending) => pending.id === pendingEntry.id);
      return i === -1
        ? {}
        : { prPendingActions: [...s.prPendingActions.slice(0, i), ...s.prPendingActions.slice(i + 1)] };
    });
  }
}

/** Run one repo/account-dependent follow-up for a successful server write.
 * A stale owner makes the follow-up a no-op. If it becomes stale while awaited,
 * its loader's own request guards suppress state publication and the caller
 * continues with the original server output. A genuine same-owner failure still
 * rejects so the existing error toast remains truthful. */
async function runPrActionFollowUp(
  owner: PrActionOwner,
  followUp: () => Promise<unknown>,
): Promise<boolean> {
  if (!prActionOwnerIsCurrent(owner)) return false;
  try {
    await followUp();
  } catch (error) {
    if (!prActionOwnerIsCurrent(owner)) return false;
    throw error;
  }
  return prActionOwnerIsCurrent(owner);
}
