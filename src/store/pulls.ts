// Pull-request state for the open repo: the list plus the per-number detail and
// checks caches. Split out of `useRepo` so PR consumers don't re-render on git
// graph churn, and vice versa. Resolves the repo path + bound account lazily via
// the other stores; server-side token resolution stays behind the provider boundary.

import { create } from "zustand";

import {
  api,
  ForgeKind,
  type FileDiff,
  type GithubAccountRef,
  type MergeMethod,
  type PrCheck,
  type PrStateAction,
  type ReviewAction,
  type ReviewThread,
} from "@/lib/api";
import { detailToPr, summaryToPr, uiCommits, type PullRequest } from "@/lib/prs";
import { useRepo } from "./repo";
import { useAccounts } from "./accounts";
import {
  bumpResourceVersions,
  hasNumericKeys,
  knownPrNums,
  omit,
  pruneStalePrCaches,
} from "./pullsCache";
import {
  cancelQueuedPrListLoad,
  mergeQueuedPrListLoad,
  prListRequestKey,
  settleQueuedPrListLoad,
  type QueuedPrListLoad,
} from "./pullsQueue";
import { claimPrRequestId, ownsPrRequest } from "./pullsRequests";

let nextPrListRequestId = 1;
let nextPrChecksRequestId = 1;
let nextPrCommitsRequestId = 1;
let nextPrPendingActionId = 1;
/** The in-flight commits load that owns each PR number. The resource version
 * only detects prunes; an unchanged refresh reruns the Commits tab's
 * prsFetchedAt-keyed effect without bumping it, so two loads can overlap in the
 * same generation — only the newest may publish its result OR its error
 * (GL-164 review). Module state, not render state: nothing displays it. */
const prCommitsRequests = new Map<number, number>();

/** Store-level write categories. These are coarser than `PR_ACTION_KEY`: the
 * store coordinates domain writes, while components distinguish button labels. */
export const PR_PENDING_ACTION = {
  Merge: "merge",
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
  /** Detail cache by PR number (body, files) — re-opening a PR is instant. */
  prDetails: Record<number, PullRequest>;
  prDetailLoading: boolean;
  /** Details currently loading by PR number (request-owned, GL-166); the global
   * flag is derived — any in-flight PR. */
  prDetailLoadingByNum: Record<number, number>;
  /** Per-PR detail-load error (so the detail body can retry, not blank the list). */
  prDetailError: Record<number, string>;
  /** Lazily-loaded checks cache by PR number (the slow statusCheckRollup). */
  prChecks: Record<number, PrCheck[]>;
  prChecksLoading: boolean;
  /** Checks currently loading by PR number; the global flag is any in-flight PR. */
  prChecksLoadingByNum: Record<number, number>;
  /** Per-PR checks-load error (drives an inline retry in the Checks tab). */
  prChecksError: Record<number, string>;
  /** Lazily-loaded full-diff cache by PR number (the parsed `gh pr diff`). */
  prDiffs: Record<number, FileDiff[]>;
  prDiffLoading: boolean;
  /** Diffs currently loading by PR number (request-owned, GL-166). */
  prDiffLoadingByNum: Record<number, number>;
  /** Per-PR diff-load error (drives an inline retry in the Diff tab). */
  prDiffError: Record<number, string>;
  /** Lazily-loaded inline review-thread cache by PR number (GraphQL). */
  prThreads: Record<number, ReviewThread[]>;
  prThreadsLoading: boolean;
  /** Threads currently loading by PR number (request-owned, GL-166). */
  prThreadsLoadingByNum: Record<number, number>;
  /** Per-PR threads-load error (drives an inline retry in the threads section). */
  prThreadsError: Record<number, string>;
  /** PRs whose full commit list (paginated GraphQL, with verification) has
   * replaced the capped `gh pr view` list. Tracked so it runs once per load. */
  prCommitsLoaded: Record<number, boolean>;
  /** Per-PR commit-load error (silent; the fast-path list stays on failure). */
  prCommitsError: Record<number, string>;
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

  /** Merge a PR (`gh pr merge`), optionally deleting the head branch. */
  mergePr: (num: number, method: MergeMethod, deleteBranch: boolean) => Promise<string>;
  /** Post a discussion comment, then refresh the thread. */
  commentPr: (num: number, body: string) => Promise<string>;
  /** Submit a review (approve / request-changes / comment). */
  reviewPr: (num: number, action: ReviewAction, body: string) => Promise<string>;
  /** Close, reopen, or mark a draft PR ready for review. */
  setPrState: (num: number, action: PrStateAction) => Promise<string>;
  /** Open a new PR from `head` into `base`. Returns the new PR URL. */
  createPr: (
    base: string,
    head: string,
    title: string,
    body: string,
    draft: boolean,
  ) => Promise<string>;
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
  prDetails: {},
  prDetailLoading: false,
  prDetailLoadingByNum: {},
  prDetailError: {},
  prChecks: {},
  prChecksLoading: false,
  prChecksLoadingByNum: {},
  prChecksError: {},
  prDiffs: {},
  prDiffLoading: false,
  prDiffLoadingByNum: {},
  prDiffError: {},
  prThreads: {},
  prThreadsLoading: false,
  prThreadsLoadingByNum: {},
  prThreadsError: {},
  prCommitsLoaded: {},
  prCommitsError: {},
  prResourceVersion: {},
  prPendingActions: [],

  reset: () => {
    cancelQueuedPrListLoad(get().prsRefreshQueued, new Error("PR list refresh canceled."));
    // Orphan any in-flight commits loads: reset clears prResourceVersion, so a
    // previous repo's still-pending request would otherwise pass the version
    // check (0 === 0) and publish into the fresh state (GL-164 review).
    prCommitsRequests.clear();
    // Clearing the …LoadingByNum maps orphans the in-flight detail/diff/threads/
    // checks requests the same way: a stale settle no longer owns its slot, so
    // it publishes nothing and can't clear a fresh request's flag (GL-166).
    set({
      pullRequests: [],
      prDetails: {},
      prDetailError: {},
      prChecks: {},
      prChecksError: {},
      prDiffs: {},
      prDiffError: {},
      prThreads: {},
      prThreadsError: {},
      prCommitsLoaded: {},
      prCommitsError: {},
      prResourceVersion: {},
      prsFetchedAt: null,
      prsRefreshInFlight: false,
      prsRefreshRequestId: null,
      prsRefreshKey: null,
      prsRefreshQueued: null,
      prError: null,
      prsLoading: false,
      prChecksLoadingByNum: {},
      prChecksLoading: false,
      prDetailLoadingByNum: {},
      prDetailLoading: false,
      prDiffLoadingByNum: {},
      prDiffLoading: false,
      prThreadsLoadingByNum: {},
      prThreadsLoading: false,
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
            prDetails: {},
            prChecks: {},
            prDiffs: {},
            prThreads: {},
            prDetailError: {},
            prChecksError: {},
            prDiffError: {},
            prThreadsError: {},
            prCommitsLoaded: {},
            prCommitsError: {},
            prChecksLoadingByNum: {},
            prChecksLoading: false,
            // Evict the in-flight detail/diff/threads slots too (same as the
            // quiet-refresh prune), so the derived flags clear now instead of
            // holding a spinner until the orphaned request settles (GL-166).
            prDetailLoadingByNum: {},
            prDetailLoading: false,
            prDiffLoadingByNum: {},
            prDiffLoading: false,
            prThreadsLoadingByNum: {},
            prThreadsLoading: false,
            // Bump every known PR's version so an in-flight detail/diff/threads
            // load (which captured the old value) discards its pre-refresh write
            // instead of repopulating the just-cleared cache and making the
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
      const list = await api.listPullRequests(path, account);
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
  loadPrDetail: async (num, force) => {
    const summary = useRepo.getState().summary;
    if (!summary) return;
    if (!force && get().prDetails[num]) return;
    const account = useAccounts.getState().prAccountRef();
    // Pin the response to the repo+account it was fetched under and to the PR's
    // cache generation (a refresh prune bumps it mid-flight).
    const key = prListRequestKey(summary.path, account);
    const version = get().prResourceVersion[num] ?? 0;
    // Claim this PR's detail slot: only the current owner may publish or clear
    // loading, so a repo switch (reset clears the map) or a newer load orphans
    // this request instead of letting it write into the fresh state (GL-166).
    const requestId = claimPrRequestId();
    set((s) => ({
      prDetailLoading: true,
      prDetailLoadingByNum: { ...s.prDetailLoadingByNum, [num]: requestId },
      prDetailError: omit(s.prDetailError, num),
    }));
    try {
      const detail = await api.pullRequestDetail(summary.path, num, account);
      set((s) => {
        // Superseded by a newer request or orphaned by reset → drop everything.
        if (!ownsPrRequest(s.prDetailLoadingByNum, num, requestId)) return {};
        const loadingByNum = omit(s.prDetailLoadingByNum, num);
        const loading = { prDetailLoadingByNum: loadingByNum, prDetailLoading: hasNumericKeys(loadingByNum) };
        // Publish only while the repo+account is still the one fetched under and
        // no refresh pruned this PR mid-flight; either way clear our own token.
        if (currentPrListRequestKey() !== key || (s.prResourceVersion[num] ?? 0) !== version)
          return loading;
        return {
          ...loading,
          prDetails: { ...s.prDetails, [num]: detailToPr(detail) },
          // Fresh commits (verified: false) — drop the applied marker so the lazy
          // signature fetch re-runs for this PR.
          prCommitsLoaded: omit(s.prCommitsLoaded, num),
        };
      });
    } catch (e) {
      set((s) => {
        if (!ownsPrRequest(s.prDetailLoadingByNum, num, requestId)) return {};
        const loadingByNum = omit(s.prDetailLoadingByNum, num);
        const loading = { prDetailLoadingByNum: loadingByNum, prDetailLoading: hasNumericKeys(loadingByNum) };
        if (currentPrListRequestKey() !== key || (s.prResourceVersion[num] ?? 0) !== version)
          return loading;
        return { ...loading, prDetailError: { ...s.prDetailError, [num]: String(e) } };
      });
    }
  },

  // Lazily loaded (the slow statusCheckRollup) and cached by number.
  loadPrChecks: async (num, force) => {
    const summary = useRepo.getState().summary;
    if (!summary) return;
    if (!force && get().prChecksLoadingByNum[num]) return;
    if (!force && get().prChecks[num]) return;
    const account = useAccounts.getState().prAccountRef();
    const path = summary.path;
    // Pin the response to the repo+account it was fetched under, so an in-flight
    // checks request can't pin stale checks after the bound account changes.
    const key = prListRequestKey(path, account);
    const requestId = nextPrChecksRequestId++;
    set((s) => ({
      prChecksLoading: true,
      prChecksLoadingByNum: { ...s.prChecksLoadingByNum, [num]: requestId },
      prChecksError: omit(s.prChecksError, num),
    }));
    try {
      const checks = await api.pullRequestChecks(path, num, account);
      set((s) => {
        // Superseded by a newer request for this PR → drop without touching its token.
        if (s.prChecksLoadingByNum[num] !== requestId) return {};
        const loadingByNum = omit(s.prChecksLoadingByNum, num);
        const loading = { prChecksLoadingByNum: loadingByNum, prChecksLoading: hasNumericKeys(loadingByNum) };
        // Always clear our own token; only cache the result if the repo+account
        // is still the one we fetched under (else the response is stale).
        if (currentPrListRequestKey() !== key) return loading;
        return { ...loading, prChecks: { ...s.prChecks, [num]: checks } };
      });
    } catch (e) {
      set((s) => {
        if (s.prChecksLoadingByNum[num] !== requestId) return {};
        const loadingByNum = omit(s.prChecksLoadingByNum, num);
        const loading = { prChecksLoadingByNum: loadingByNum, prChecksLoading: hasNumericKeys(loadingByNum) };
        // Surface the error only when the response is still for the current
        // repo+account; either way clear the token so retries aren't blocked.
        if (currentPrListRequestKey() !== key) return loading;
        return { ...loading, prChecksError: { ...s.prChecksError, [num]: String(e) } };
      });
    }
  },

  // Lazily fetch the full, verified commit list (paginated GraphQL) and replace
  // the cached detail's capped `gh pr view` commits. Supplementary: on failure
  // keep the fast-path list rather than blanking the Commits tab.
  loadPrCommits: async (num, force) => {
    const summary = useRepo.getState().summary;
    if (!summary) return;
    if (!force && get().prCommitsLoaded[num]) return;
    const detail = get().prDetails[num];
    if (!detail) return;
    const account = useAccounts.getState().prAccountRef();
    // Pin the response to the repo+account it was fetched under, like the other
    // per-PR resources (GL-166).
    const key = prListRequestKey(summary.path, account);
    const version = get().prResourceVersion[num] ?? 0;
    // Claim this PR's commits slot: a newer overlapping load takes it over, and
    // only the owner may publish either outcome — the version alone can't tell
    // two same-generation requests apart (GL-164 review).
    const requestId = nextPrCommitsRequestId++;
    prCommitsRequests.set(num, requestId);
    const ownsRequest = () => prCommitsRequests.get(num) === requestId;
    set((s) => ({ prCommitsError: omit(s.prCommitsError, num) }));
    try {
      const commits = await api.pullRequestCommits(summary.path, num, account);
      set((s) => {
        const d = s.prDetails[num];
        // Skip if superseded by a newer load, fetched under a stale repo/account,
        // pruned mid-flight, or the detail was evicted under us.
        if (
          !ownsRequest() ||
          !d ||
          currentPrListRequestKey() !== key ||
          (s.prResourceVersion[num] ?? 0) !== version
        )
          return {};
        return {
          prDetails: {
            ...s.prDetails,
            [num]: { ...d, commits: uiCommits(commits, d.url) },
          },
          prCommitsLoaded: { ...s.prCommitsLoaded, [num]: true },
        };
      });
    } catch (e) {
      set((s) => {
        // Superseded, stale repo/account, or a refresh pruned this PR mid-flight
        // → the error belongs to a request that no longer owns the slot; discard
        // it like the success path does (GL-164, mirroring loadPrDiff).
        if (
          !ownsRequest() ||
          currentPrListRequestKey() !== key ||
          (s.prResourceVersion[num] ?? 0) !== version
        )
          return {};
        return { prCommitsError: { ...s.prCommitsError, [num]: String(e) } };
      });
    } finally {
      // Release the slot only if this request still owns it — a newer load's
      // claim must survive an older request settling late.
      if (ownsRequest()) prCommitsRequests.delete(num);
    }
  },

  // Lazily loaded (the full `gh pr diff`, parsed server-side) and cached by number.
  loadPrDiff: async (num, force) => {
    const summary = useRepo.getState().summary;
    if (!summary) return;
    if (!force && get().prDiffs[num]) return;
    const account = useAccounts.getState().prAccountRef();
    // Same ownership scheme as loadPrDetail (GL-166): slot id + repo/account key
    // + cache generation.
    const key = prListRequestKey(summary.path, account);
    const version = get().prResourceVersion[num] ?? 0;
    const requestId = claimPrRequestId();
    set((s) => ({
      prDiffLoading: true,
      prDiffLoadingByNum: { ...s.prDiffLoadingByNum, [num]: requestId },
      prDiffError: omit(s.prDiffError, num),
    }));
    try {
      const diffs = await api.pullRequestDiff(summary.path, num, account);
      set((s) => {
        if (!ownsPrRequest(s.prDiffLoadingByNum, num, requestId)) return {};
        const loadingByNum = omit(s.prDiffLoadingByNum, num);
        const loading = { prDiffLoadingByNum: loadingByNum, prDiffLoading: hasNumericKeys(loadingByNum) };
        if (currentPrListRequestKey() !== key || (s.prResourceVersion[num] ?? 0) !== version)
          return loading;
        return { ...loading, prDiffs: { ...s.prDiffs, [num]: diffs } };
      });
    } catch (e) {
      set((s) => {
        if (!ownsPrRequest(s.prDiffLoadingByNum, num, requestId)) return {};
        const loadingByNum = omit(s.prDiffLoadingByNum, num);
        const loading = { prDiffLoadingByNum: loadingByNum, prDiffLoading: hasNumericKeys(loadingByNum) };
        if (currentPrListRequestKey() !== key || (s.prResourceVersion[num] ?? 0) !== version)
          return loading;
        return { ...loading, prDiffError: { ...s.prDiffError, [num]: String(e) } };
      });
    }
  },

  // Lazily loaded (GraphQL review threads) and cached by number.
  loadPrThreads: async (num, force) => {
    const summary = useRepo.getState().summary;
    if (!summary) return;
    if (!force && get().prThreads[num]) return;
    const account = useAccounts.getState().prAccountRef();
    // Same ownership scheme as loadPrDetail (GL-166): slot id + repo/account key
    // + cache generation.
    const key = prListRequestKey(summary.path, account);
    const version = get().prResourceVersion[num] ?? 0;
    const requestId = claimPrRequestId();
    set((s) => ({
      prThreadsLoading: true,
      prThreadsLoadingByNum: { ...s.prThreadsLoadingByNum, [num]: requestId },
      prThreadsError: omit(s.prThreadsError, num),
    }));
    try {
      const threads = await api.pullRequestReviewThreads(summary.path, num, account);
      set((s) => {
        if (!ownsPrRequest(s.prThreadsLoadingByNum, num, requestId)) return {};
        const loadingByNum = omit(s.prThreadsLoadingByNum, num);
        const loading = { prThreadsLoadingByNum: loadingByNum, prThreadsLoading: hasNumericKeys(loadingByNum) };
        if (currentPrListRequestKey() !== key || (s.prResourceVersion[num] ?? 0) !== version)
          return loading;
        return { ...loading, prThreads: { ...s.prThreads, [num]: threads } };
      });
    } catch (e) {
      set((s) => {
        if (!ownsPrRequest(s.prThreadsLoadingByNum, num, requestId)) return {};
        const loadingByNum = omit(s.prThreadsLoadingByNum, num);
        const loading = { prThreadsLoadingByNum: loadingByNum, prThreadsLoading: hasNumericKeys(loadingByNum) };
        if (currentPrListRequestKey() !== key || (s.prResourceVersion[num] ?? 0) !== version)
          return loading;
        return { ...loading, prThreadsError: { ...s.prThreadsError, [num]: String(e) } };
      });
    }
  },

  resolveThread: async (num, threadId, resolved) => {
    const out = await runPrAction(
      (path, account) => api.resolveReviewThread(path, threadId, resolved, account),
      { trackPending: false },
    );
    await get().loadPrThreads(num, true);
    return out;
  },

  replyThread: async (num, threadId, body) => {
    const out = await runPrAction(
      (path, account) => api.replyReviewThread(path, threadId, body, account),
      { trackPending: false },
    );
    await get().loadPrThreads(num, true);
    return out;
  },

  mergePr: async (num, method, deleteBranch) => {
    const out = await runPrAction(
      (path, account) => api.mergePullRequest(path, num, method, deleteBranch, account),
      { action: PR_PENDING_ACTION.Merge, prNum: num },
    );
    // State + checked-out branch can both change; reload the list and this PR.
    await get().loadPullRequests(true);
    await get().loadPrDetail(num, true);
    void useRepo.getState().refresh({ prs: false });
    return out;
  },

  commentPr: async (num, body) => {
    const out = await runPrAction(
      (path, account) => api.commentPullRequest(path, num, body, account),
      { action: PR_PENDING_ACTION.Comment, prNum: num },
    );
    await get().loadPrDetail(num, true);
    return out;
  },

  reviewPr: async (num, action, body) => {
    const out = await runPrAction(
      (path, account) => api.reviewPullRequest(path, num, action, body, account),
      { action: PR_PENDING_ACTION.Review, prNum: num, reviewAction: action },
    );
    await get().loadPrDetail(num, true);
    void get().loadPrChecks(num, true);
    return out;
  },

  setPrState: async (num, action) => {
    const out = await runPrAction(
      (path, account) => api.setPullRequestState(path, num, action, account),
      { action: PR_PENDING_ACTION.State, prNum: num, stateAction: action },
    );
    await get().loadPullRequests(true);
    await get().loadPrDetail(num, true);
    return out;
  },

  createPr: async (base, head, title, body, draft) => {
    const out = await runPrAction(
      (path, account) => api.createPullRequest(path, base, head, title, body, draft, account),
      { action: PR_PENDING_ACTION.Create, prNum: null },
    );
    await get().loadPullRequests(true);
    return out;
  },
}));

// Repo + bound account identity of the currently-open repo, or null when none.
function currentPrListRequestKey(): string | null {
  const summary = useRepo.getState().summary;
  if (!summary) return null;
  return prListRequestKey(summary.path, useAccounts.getState().prAccountRef());
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
async function runPrAction(
  body: (path: string, account: GithubAccountRef | null) => Promise<string>,
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
): Promise<string> {
  const summary = useRepo.getState().summary;
  if (!summary) throw new Error("No repository");
  const account = useAccounts.getState().prAccountRef();
  if (!trackPending || !action) return await body(summary.path, account);
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
    return await body(summary.path, account);
  } finally {
    usePulls.setState((s) => {
      const i = s.prPendingActions.findIndex((pending) => pending.id === pendingEntry.id);
      return i === -1
        ? {}
        : { prPendingActions: [...s.prPendingActions.slice(0, i), ...s.prPendingActions.slice(i + 1)] };
    });
  }
}
