// Pull-request state for the open repo: the list plus the per-number detail and
// checks caches. Split out of `useRepo` so PR consumers don't re-render on git
// graph churn, and vice versa. Resolves the repo path + bound account lazily via
// the other stores; server-side token resolution stays behind the provider boundary.

import { create } from "zustand";

import {
  api,
  ForgeKind,
  type GithubAccountRef,
  type MergeMethod,
  type PrCreateInput,
  type PrReviewerCandidate,
  type PrStack,
  type PrStackMembership,
  type PrStateAction,
  type ReviewAction,
} from "@/lib/api";
import { detailToPr, summaryToPr, uiCommits, type PullRequest } from "@/lib/prs";
import { useNotifications } from "./notifications";
import { useRepo } from "./repo";
import { useAccounts } from "./accounts";
import { bumpResourceVersions, knownPrNums, pruneStalePrCaches } from "./pullsCache";
import {
  cancelQueuedPrListLoad,
  mergeQueuedPrListLoad,
  prListRequestKey,
  settleQueuedPrListLoad,
  type QueuedPrListLoad,
} from "./pullsQueue";
import {
  capturePrActionContext,
  prActionOwnerIsCurrent,
  type PrActionOwner,
} from "./pullsActionOwner";
import {
  clearPrResources,
  currentPrListRequestKey,
  emptyPrResources,
  loadPrResource,
  omit,
  patchPrResource,
  PR_RESOURCE,
  type PrResources,
} from "./pullsResource";

let nextPrListRequestId = 1;
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

interface PullsState {
  /** Pull requests for the open repo (from `gh`, via the bound account). */
  pullRequests: PullRequest[];
  prsLoading: boolean;
  /**
   * List-load error only (gh missing, no GitHub remote, not logged in). Scoped
   * to the list so a single PR's detail/diff/checks/threads failure can't blank
   * the sidebar — those surface in the per-PR error maps below instead.
   */
  prError: string | null;
  /** Epoch ms when the PR list was last successfully fetched (for "updated …"). */
  prsFetchedAt: number | null;
  /** Non-visual in-flight guard for foreground and quiet PR list refreshes. */
  prsRefreshInFlight: boolean;
  /** Monotonic id for the active PR-list fetch, so stale completions no-op. */
  prsRefreshRequestId: number | null;
  /** Repo/account identity for the active PR-list fetch. */
  prsRefreshKey: string | null;
  /** Foreground/force load requested while another PR-list fetch is in flight. */
  prsRefreshQueued: QueuedPrListLoad | null;
  /** The five lazily-loaded per-PR resources — detail, checks, diff, threads,
   * commits — each `{ data, slots, errors }` keyed by PR number (GL-364).
   * `slots` are the in-flight request claims (request-owned, GL-166); reads go
   * straight through the record (`s.prResources.checks.data[num]`). The commits
   * resource caches only a marker — its payload patches the cached detail. */
  prResources: PrResources;
  /** Stack membership for every PR in the list, keyed by PR number — the badge
   * on each row. Fetched with the list (one call for all of them), unlike
   * `prStacks`, which is per-PR and only covers an open detail. */
  prStackBadges: Record<number, PrStackMembership>;
  /** The stack each PR belongs to, fetched with its detail. A PR absent from
   * this map is simply not stacked — by far the common case — so there is no
   * separate loading or error state for it. */
  prStacks: Record<number, PrStack>;
  /**
   * Per-PR cache generation, bumped when a refresh prunes a PR's stale caches.
   * In-flight detail/diff/threads/signature loads capture it and discard their
   * write if it changed, so a load started before the prune can't repopulate the
   * just-evicted cache with a pre-refresh response.
   */
  prResourceVersion: Record<number, number>;
  /**
   * The PR write ops currently in flight, as
   * a multiset so concurrent writes are tracked independently — one action's
   * completion can't clear another's busy state. A control disables while any are
   * pending; PR-specific feedback matches both `PR_PENDING_ACTION` and `prNum`.
   */
  prPendingActions: PrPendingAction[];

  /** Clear the list + caches (on repo open / close / switch). */
  reset: () => void;
  /**
   * Fetch the PR list. `force` clears the detail/checks caches first. `quiet`
   * skips the loading flag (for passive focus/fs re-syncs) so the list doesn't
   * flicker; user-initiated loads omit it to surface the spinner.
   */
  loadPullRequests: (force?: boolean, quiet?: boolean) => Promise<void>;
  /** Manual refresh of the PRs view (force-reload list + caches). */
  refreshPullRequests: () => Promise<void>;
  /** Load + cache a PR's detail. No-ops if cached (unless `force`). */
  loadPrDetail: (num: number, force?: boolean) => Promise<void>;
  /** Lazily load + cache a PR's checks. No-ops if cached (unless `force`). */
  loadPrChecks: (num: number, force?: boolean) => Promise<void>;
  /** Lazily fetch the full paginated commit list and replace the cached detail's
   * capped commits. No-ops if already loaded for this detail (unless `force`). */
  loadPrCommits: (num: number, force?: boolean) => Promise<void>;
  /** Lazily load + cache a PR's full diff. No-ops if cached (unless `force`). */
  loadPrDiff: (num: number, force?: boolean) => Promise<void>;
  /** Lazily load + cache a PR's inline review threads. No-ops if cached. */
  loadPrThreads: (num: number, force?: boolean) => Promise<void>;
  /** Resolve / unresolve a review thread, then refresh that PR's threads. */
  resolveThread: (num: number, threadId: string, resolved: boolean) => Promise<string>;
  /** Reply to a review thread, then refresh that PR's threads. */
  replyThread: (num: number, threadId: string, body: string) => Promise<string>;

  // ---- Write actions. Each runs via the bound account, refreshes the affected
  // caches, and resolves with gh's output (or rejects so the caller can toast). ----

  /** Merge a PR (`gh pr merge`), optionally deleting the head branch. Resolves
   * with an empty string — the outcome is reported as a toast, not returned
   * (GL-345); the shared runner only reads resolution as a success signal. */
  mergePr: (num: number, method: MergeMethod, deleteBranch: boolean) => Promise<string>;
  /** Atomically merge this PR and every unmerged layer below it in its stack.
   * All-or-nothing: if any layer can't merge, none of them do. */
  mergeStack: (num: number, method: MergeMethod) => Promise<string>;
  /** Post a discussion comment, then refresh the thread. */
  commentPr: (num: number, body: string) => Promise<string>;
  /** Submit a review (approve / request-changes / comment). */
  reviewPr: (num: number, action: ReviewAction, body: string) => Promise<string>;
  /** Close, reopen, or mark a draft PR ready for review. */
  setPrState: (num: number, action: PrStateAction) => Promise<string>;
  /** Open a new PR from `input.head` into `input.base`. Returns the new PR URL.
   *
   * `stackBelow` are the pull request numbers of the layers underneath,
   * bottom-first. When present the new pull request is linked into a GitHub
   * stack after it is created — a second step, because the base alone only
   * makes the branch chain. */
  createPr: (input: PrCreateInput, stackBelow?: number[]) => Promise<string>;
  /** People who can be asked to review here. Resolves to `[]` — rather than
   * rejecting — for providers without a reviewer lookup and for a caller
   * without push access, so the picker hides instead of failing the dialog. */
  loadReviewerCandidates: () => Promise<PrReviewerCandidate[]>;
}

export const usePulls = create<PullsState>((set, get) => ({
  pullRequests: [],
  prsLoading: false,
  prError: null,
  prsFetchedAt: null,
  prsRefreshInFlight: false,
  prsRefreshRequestId: null,
  prsRefreshKey: null,
  prsRefreshQueued: null,
  prResources: emptyPrResources(),
  prStackBadges: {},
  prStacks: {},
  prResourceVersion: {},
  prPendingActions: [],

  reset: () => {
    cancelQueuedPrListLoad(get().prsRefreshQueued, new Error("PR list refresh canceled."));
    // Emptying every resource's slots orphans every in-flight per-PR request: a
    // stale settle no longer owns its slot, so it publishes nothing and can't
    // clear a fresh request's flag (GL-166). Commits rely on this too — reset
    // clears prResourceVersion, so a previous repo's still-pending request would
    // otherwise pass the version check (0 === 0) and publish into the fresh
    // state (GL-164 review).
    set({
      pullRequests: [],
      prResources: emptyPrResources(),
      prStackBadges: {},
      prStacks: {},
      prResourceVersion: {},
      prsFetchedAt: null,
      prsRefreshInFlight: false,
      prsRefreshRequestId: null,
      prsRefreshKey: null,
      prsRefreshQueued: null,
      prError: null,
      prsLoading: false,
      prPendingActions: [],
    });
  },

  // Fetch the repo's PRs via `gh`, pinned to the bound account when set.
  // Failures (gh missing, no GitHub remote, not logged in) surface as `prError`
  // and leave the list empty — never throw into the UI.
  loadPullRequests: async (force = false, quiet = false) => {
    const { summary, forge } = useRepo.getState();
    if (!summary) {
      set({ pullRequests: [], prError: null });
      return;
    }
    // Pull requests are supported for GitHub (via `gh`), GitLab (via glab /
    // REST v4, GL-140), and Bitbucket Cloud (via REST 2.0, GL-141). For any other
    // forge — or a repo with no remote — skip the provider resolution entirely
    // instead of surfacing a confusing "couldn't resolve a repository" error.
    if (
      forge &&
      forge.kind !== ForgeKind.GitHub &&
      forge.kind !== ForgeKind.GitLab &&
      forge.kind !== ForgeKind.Bitbucket
    ) {
      set({
        pullRequests: [],
        prsLoading: false,
        prError: forge.hasRemote
          ? `Pull requests aren't available for ${forge.forge ?? forge.host ?? "this remote"}.`
          : "This repository has no remote, so there are no pull requests.",
      });
      return;
    }
    const account = useAccounts.getState().prAccountRef();
    const path = summary.path;
    const key = prListRequestKey(path, account);
    if (get().prsRefreshInFlight) {
      const shouldQueue = force || key !== get().prsRefreshKey;
      const queuedPromise = shouldQueue
        ? new Promise<void>((resolve, reject) => {
            set((s) => ({
              ...(!quiet ? { prsLoading: true, prError: null } : {}),
              prsRefreshQueued: mergeQueuedPrListLoad(s.prsRefreshQueued, {
                force,
                quiet,
                waiters: [{ resolve, reject, force, key }],
              }),
            }));
          })
        : undefined;
      if (!shouldQueue && !quiet) {
        set({ prsLoading: true, prError: null });
      }
      await queuedPromise;
      return;
    }
    const requestId = nextPrListRequestId++;
    set((s) => ({
      prsRefreshInFlight: true,
      prsRefreshRequestId: requestId,
      prsRefreshKey: key,
      ...(quiet ? {} : { prsLoading: true }),
      prError: null,
      ...(force
        ? {
            // Every resource's cache, error, and in-flight slot cleared (the
            // same commits-slot exception as the quiet-refresh prune), so
            // per-PR spinners clear now instead of holding until the orphaned
            // request settles (GL-166).
            prResources: clearPrResources(s.prResources),
            prStacks: {},
            // Bump every known PR's version so an in-flight load (which
            // captured the old value) discards its pre-refresh write instead of
            // repopulating the just-cleared cache and making the
            // prsFetchedAt-triggered reload skip on a stale cache hit.
            prResourceVersion: bumpResourceVersions(s.prResourceVersion, knownPrNums(s)),
          }
        : {}),
    }));
    const runQueued = async () => {
      const queued = get().prsRefreshQueued;
      if (!queued) return;
      // Dequeue before awaiting, so reset() can no longer cancel this waiter.
      // Guard identity ourselves instead: settle each waiter against the current
      // repo+account so callers (mergePr/setPrState) don't run follow-up detail
      // loads against the wrong repo or under the wrong account. Per-waiter,
      // since coalescing keeps older waiters across an account/repo change.
      set({ prsRefreshQueued: null });
      try {
        await get().loadPullRequests(queued.force, queued.quiet);
        settleQueuedPrListLoad(queued, currentPrListRequestKey());
      } catch (e) {
        cancelQueuedPrListLoad(queued, e);
      }
    };
    // Release the in-flight slot without writing data — used when the response
    // is for a now-stale repo/account, so the queued reload can still run.
    const releaseSlot = () =>
      set({
        prsLoading: false,
        prsRefreshInFlight: false,
        prsRefreshRequestId: null,
        prsRefreshKey: null,
      });
    try {
      // Stack membership for the whole list in one call, so every row can carry
      // its badge — the per-PR stack read only covers an open detail. Like the
      // detail's companion read, a failure must not cost the list: `undefined`
      // (unreadable) keeps the previous badges, `[]` means no stacks exist.
      const [list, memberships] = await Promise.all([
        api.listPullRequests(path, account),
        api.repositoryStacks(path, account).catch(() => undefined),
      ]);
      // Superseded after a reset (repo switch) — a newer load owns the slot.
      if (!prListLoadOwnsSlot(requestId)) return;
      // Fetched under a now-stale repo/account (an account change queued a reload
      // under a new key): don't write account-A data as the bound account's list;
      // release the slot so the queued reload runs.
      if (currentPrListRequestKey() !== key) {
        releaseSlot();
      } else {
        const prs = list.map(summaryToPr);
        set((s) => ({
          pullRequests: prs,
          ...(memberships === undefined
            ? {}
            : { prStackBadges: Object.fromEntries(memberships.map((m) => [m.prNumber, m])) }),
          // Force already cleared the caches above; on a quiet/background refresh,
          // evict the per-PR caches for any PR whose summary changed so no tab
          // (detail/diff/checks) keeps showing stale data.
          ...(force ? {} : pruneStalePrCaches(s, prs)),
          prsLoading: false,
          prsRefreshInFlight: false,
          prsRefreshRequestId: null,
          prsRefreshKey: null,
          prsFetchedAt: Date.now(),
        }));
      }
      await runQueued();
    } catch (e) {
      if (!prListLoadOwnsSlot(requestId)) return;
      if (currentPrListRequestKey() !== key) {
        releaseSlot();
      } else if (quiet && get().prsFetchedAt != null) {
        releaseSlot();
      } else {
        set({
          pullRequests: [],
          prsLoading: false,
          prsRefreshInFlight: false,
          prsRefreshRequestId: null,
          prsRefreshKey: null,
          // Clearing the list invalidates the "last successful fetch" marker, so a
          // later quiet retry can't treat this errored/empty state as a cache to
          // preserve and silently drop the real error.
          prsFetchedAt: null,
          prError: String(e),
        });
      }
      await runQueued();
    }
  },

  // Force-refresh: drop caches and refetch the list. The detail/checks views
  // re-fetch on their own because their effects key off `prsFetchedAt`. Called
  // fire-and-forget from the panel button, so swallow the cancellation that a
  // repo switch/close raises when this forced load was queued behind a prefetch.
  refreshPullRequests: async () => {
    try {
      await get().loadPullRequests(true);
    } catch {
      /* canceled by a repo switch/close — there's nothing left to refresh */
    }
  },

  // Cached by number — re-opening a previously-viewed PR is instant.
  loadPrDetail: (num, force) =>
    loadPrResource(set, get, {
      kind: PR_RESOURCE.Detail,
      num,
      force,
      // The stack rides the detail request rather than owning a lazy slot of its
      // own: it is one small GraphQL read, the card renders with the PR body, and
      // it inherits the shared staleness guards instead of duplicating them. A
      // stack read that fails must not cost the user the whole PR detail.
      fetch: (path, n, account) =>
        Promise.all([
          api.pullRequestDetail(path, n, account),
          api.pullRequestStack(path, n, account).catch(() => undefined),
        ]),
      publish: (s, [detail, stack]) => ({
        prResources: patchPrResource(
          // Fresh commits (verified: false) — drop the applied marker so the
          // lazy verified-commits fetch re-runs for this PR.
          patchPrResource(s.prResources, PR_RESOURCE.Commits, {
            data: omit(s.prResources.commits.data, num),
          }),
          PR_RESOURCE.Detail,
          { data: { ...s.prResources.detail.data, [num]: detailToPr(detail) } },
        ),
        // Stacked → publish. Confirmed unstacked (null) → clear, so a stack this
        // PR left doesn't linger. Unreadable (undefined) → keep whatever was
        // there; a failed read is not evidence the stack is gone. Collapsing the
        // two let one transient GraphQL blip delete a working stack card, which —
        // with a cached detail short-circuiting the next load — never came back
        // until a forced refresh.
        prStacks:
          stack === undefined
            ? s.prStacks
            : stack === null
              ? omit(s.prStacks, num)
              : { ...s.prStacks, [num]: stack },
      }),
    }),

  // Lazily loaded (the slow statusCheckRollup) and cached by number. Unlike its
  // siblings an unforced load also skips while one is already in flight — the
  // Checks tab polls, so a slow rollup would otherwise stack up requests.
  loadPrChecks: (num, force) =>
    loadPrResource(set, get, {
      kind: PR_RESOURCE.Checks,
      num,
      force,
      skip: (s) => !!s.prResources.checks.slots[num] || num in s.prResources.checks.data,
      fetch: (path, n, account) => api.pullRequestChecks(path, n, account),
    }),

  // Lazily fetch the full, verified commit list (paginated GraphQL) and replace
  // the cached detail's capped `gh pr view` commits. Supplementary: on failure
  // keep the fast-path list rather than blanking the Commits tab.
  loadPrCommits: (num, force) => {
    // A precondition rather than a cache check — this load patches the cached
    // detail's commits, so without one there is nothing to patch even when forced.
    if (!get().prResources.detail.data[num]) return Promise.resolve();
    return loadPrResource(set, get, {
      kind: PR_RESOURCE.Commits,
      num,
      force,
      fetch: (path, n, account) => api.pullRequestCommits(path, n, account),
      publish: (s, result) => {
        const detail = s.prResources.detail.data[num];
        // The detail was evicted under us — there is nothing left to patch.
        if (!detail) return {};
        return {
          prResources: patchPrResource(
            patchPrResource(s.prResources, PR_RESOURCE.Detail, {
              data: {
                ...s.prResources.detail.data,
                [num]: { ...detail, commits: uiCommits(result.commits, detail.url) },
              },
            }),
            PR_RESOURCE.Commits,
            {
              data: {
                ...s.prResources.commits.data,
                [num]: { truncated: result.truncated },
              },
            },
          ),
        };
      },
    });
  },

  // Lazily loaded (the full `gh pr diff`, parsed server-side) and cached by number.
  loadPrDiff: (num, force) =>
    loadPrResource(set, get, {
      kind: PR_RESOURCE.Diff,
      num,
      force,
      fetch: (path, n, account) => api.pullRequestDiff(path, n, account),
    }),

  // Lazily loaded (GraphQL review threads) and cached by number.
  // The API result is structurally the payload ({ threads, truncated }), so the
  // default publish caches it whole.
  loadPrThreads: (num, force) =>
    loadPrResource(set, get, {
      kind: PR_RESOURCE.Threads,
      num,
      force,
      fetch: (path, n, account) => api.pullRequestReviewThreads(path, n, account),
    }),

  resolveThread: async (num, threadId, resolved) => {
    const { output, owner } = await runPrAction(
      (path, account) => api.resolveReviewThread(path, threadId, resolved, account),
      { trackPending: false },
    );
    await runPrActionFollowUp(owner, () => get().loadPrThreads(num, true));
    return output;
  },

  replyThread: async (num, threadId, body) => {
    const { output, owner } = await runPrAction(
      (path, account) => api.replyReviewThread(path, threadId, body, account),
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
}));

/** The number in a pull request URL's trailing `/pull/<n>` segment. */
function prNumberFromUrl(url: string): number | null {
  const match = /\/pull\/(\d+)/.exec(url.trim());
  return match ? Number(match[1]) : null;
}

// Whether this load still owns the in-flight slot. False only after reset()
// cleared it (repo switch) and a newer load took over — in which case this load
// must not touch the shared flags. An account change does NOT reset the slot (it
// queues a reload), so ownership persists and the key check below handles it.
function prListLoadOwnsSlot(requestId: number): boolean {
  return usePulls.getState().prsRefreshRequestId === requestId;
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
