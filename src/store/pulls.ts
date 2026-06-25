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
} from "../lib/api";
import { applyCommitSignatures, detailToPr, summaryToPr, type PullRequest } from "../lib/prs";
import { useRepo } from "./repo";
import { useAccounts } from "./accounts";

let nextPrListRequestId = 1;
let nextPrChecksRequestId = 1;

/** Which PR write op is in flight, so each control shows only its own busy state. */
export type PrPendingAction = "merge" | "comment" | "review" | "state" | "create";

interface QueuedPrListLoad {
  /** force/quiet of the coalesced re-run (OR of force, AND of quiet across waiters). */
  force: boolean;
  quiet: boolean;
  waiters: PrListQueueWaiter[];
}

interface PrListQueueWaiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  /**
   * Whether the waiter's caller awaits a force/foreground refresh. On cancellation
   * (repo switch/reset) force waiters reject so awaited callers stop; non-force
   * fire-and-forget reloads resolve quietly to avoid unhandled rejections.
   */
  force: boolean;
  /**
   * Repo + account identity this waiter requested. Tracked per-waiter (not per-
   * queue) because coalescing keeps older waiters while the queue re-runs under
   * whatever is current — a waiter whose key no longer matches must be canceled,
   * not resolved against another account's data.
   */
  key: string;
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
  /** Per-PR diff-load error (drives an inline retry in the Diff tab). */
  prDiffError: Record<number, string>;
  /** Lazily-loaded inline review-thread cache by PR number (GraphQL). */
  prThreads: Record<number, ReviewThread[]>;
  prThreadsLoading: boolean;
  /** Per-PR threads-load error (drives an inline retry in the threads section). */
  prThreadsError: Record<number, string>;
  /** PRs whose commit signatures have been merged into `prDetails` (GraphQL).
   * Tracked so the lazy verification fetch runs once per detail load. */
  prCommitSigsLoaded: Record<number, boolean>;
  /** Per-PR signature-load error (silent; badges just stay absent on failure). */
  prCommitSigsError: Record<number, string>;
  /**
   * The PR write ops currently in flight (merge/comment/review/state/create), as
   * a multiset so concurrent writes are tracked independently — one action's
   * completion can't clear another's busy state. A control disables while any are
   * pending; the merge button shows "Merging…" only when "merge" is among them.
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
  /** Lazily fetch per-commit signatures and merge them into the cached detail's
   * commits. No-ops if already applied for this detail load (unless `force`). */
  loadPrCommitSignatures: (num: number, force?: boolean) => Promise<void>;
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
  prDetailError: {},
  prChecks: {},
  prChecksLoading: false,
  prChecksLoadingByNum: {},
  prChecksError: {},
  prDiffs: {},
  prDiffLoading: false,
  prDiffError: {},
  prThreads: {},
  prThreadsLoading: false,
  prThreadsError: {},
  prCommitSigsLoaded: {},
  prCommitSigsError: {},
  prPendingActions: [],

  reset: () => {
    cancelQueuedPrListLoad(get().prsRefreshQueued, new Error("PR list refresh canceled."));
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
      prCommitSigsLoaded: {},
      prCommitSigsError: {},
      prsFetchedAt: null,
      prsRefreshInFlight: false,
      prsRefreshRequestId: null,
      prsRefreshKey: null,
      prsRefreshQueued: null,
      prError: null,
      prsLoading: false,
      prChecksLoadingByNum: {},
      prChecksLoading: false,
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
    // Pull requests are GitHub-only (they run through `gh`). For any other forge
    // — or a repo with no remote — skip the `gh` resolution entirely instead of
    // surfacing a confusing "couldn't resolve a GitHub repository" error.
    if (forge && forge.kind !== ForgeKind.GitHub) {
      set({
        pullRequests: [],
        prsLoading: false,
        prError: forge.hasRemote
          ? `Pull requests are only available for GitHub repositories. This repo's remote is ${forge.forge ?? forge.host ?? "not GitHub"}.`
          : "This repository has no remote, so there are no pull requests.",
      });
      return;
    }
    const account = useAccounts.getState().repoAccountRef;
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
    set({
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
            prCommitSigsLoaded: {},
            prCommitSigsError: {},
            prChecksLoadingByNum: {},
            prChecksLoading: false,
          }
        : {}),
    });
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
    try {
      const list = await api.listPullRequests(path, account);
      // Bail if the repo switched while this load was in flight, so a slow fetch
      // can't clobber the new repo's PR state.
      if (!isCurrentPrListRequest(requestId, path)) {
        return;
      }
      const prs = list.map(summaryToPr);
      set((s) => ({
        pullRequests: prs,
        // Force already cleared the caches above; on a quiet/background refresh,
        // drop details whose state/draft changed so the header can't stay stale.
        ...(force ? {} : { prDetails: prunePrDetails(s.prDetails, prs) }),
        prsLoading: false,
        prsRefreshInFlight: false,
        prsRefreshRequestId: null,
        prsRefreshKey: null,
        prsFetchedAt: Date.now(),
      }));
      await runQueued();
    } catch (e) {
      if (!isCurrentPrListRequest(requestId, path)) {
        return;
      }
      if (quiet && get().prsFetchedAt != null) {
        set({
          prsLoading: false,
          prsRefreshInFlight: false,
          prsRefreshRequestId: null,
          prsRefreshKey: null,
        });
      } else {
        set({
          pullRequests: [],
          prsLoading: false,
          prsRefreshInFlight: false,
          prsRefreshRequestId: null,
          prsRefreshKey: null,
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
    const account = useAccounts.getState().repoAccountRef;
    set((s) => ({ prDetailLoading: true, prDetailError: omit(s.prDetailError, num) }));
    try {
      const detail = await api.pullRequestDetail(summary.path, num, account);
      set((s) => ({
        prDetails: { ...s.prDetails, [num]: detailToPr(detail) },
        prDetailLoading: false,
        // Fresh commits (verified: false) — drop the applied marker so the lazy
        // signature fetch re-runs for this PR.
        prCommitSigsLoaded: omit(s.prCommitSigsLoaded, num),
      }));
    } catch (e) {
      set((s) => ({
        prDetailLoading: false,
        prDetailError: { ...s.prDetailError, [num]: String(e) },
      }));
    }
  },

  // Lazily loaded (the slow statusCheckRollup) and cached by number.
  loadPrChecks: async (num, force) => {
    const summary = useRepo.getState().summary;
    if (!summary) return;
    if (!force && get().prChecksLoadingByNum[num]) return;
    if (!force && get().prChecks[num]) return;
    const account = useAccounts.getState().repoAccountRef;
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
        if (!isCurrentPrChecksRequest(s, num, requestId, key)) return {};
        const loadingByNum = omit(s.prChecksLoadingByNum, num);
        return {
          prChecks: { ...s.prChecks, [num]: checks },
          prChecksLoadingByNum: loadingByNum,
          prChecksLoading: hasNumericKeys(loadingByNum),
        };
      });
    } catch (e) {
      set((s) => ({
        ...(isCurrentPrChecksRequest(s, num, requestId, key)
          ? {
              prChecksLoadingByNum: omit(s.prChecksLoadingByNum, num),
              prChecksLoading: hasNumericKeys(omit(s.prChecksLoadingByNum, num)),
              prChecksError: { ...s.prChecksError, [num]: String(e) },
            }
          : {}),
      }));
    }
  },

  // Lazily fetch per-commit signatures (GraphQL) and merge `verified` into the
  // cached detail's commits. Supplementary metadata: failures stay silent (no
  // badge) rather than blanking the Commits tab.
  loadPrCommitSignatures: async (num, force) => {
    const summary = useRepo.getState().summary;
    if (!summary) return;
    if (!force && get().prCommitSigsLoaded[num]) return;
    const detail = get().prDetails[num];
    if (!detail || detail.commits.length === 0) return;
    const account = useAccounts.getState().repoAccountRef;
    set((s) => ({ prCommitSigsError: omit(s.prCommitSigsError, num) }));
    try {
      const sigs = await api.pullRequestCommitSignatures(summary.path, num, account);
      set((s) => {
        const d = s.prDetails[num];
        if (!d) return {};
        return {
          prDetails: {
            ...s.prDetails,
            [num]: { ...d, commits: applyCommitSignatures(d.commits, sigs) },
          },
          prCommitSigsLoaded: { ...s.prCommitSigsLoaded, [num]: true },
        };
      });
    } catch (e) {
      set((s) => ({ prCommitSigsError: { ...s.prCommitSigsError, [num]: String(e) } }));
    }
  },

  // Lazily loaded (the full `gh pr diff`, parsed server-side) and cached by number.
  loadPrDiff: async (num, force) => {
    const summary = useRepo.getState().summary;
    if (!summary) return;
    if (!force && get().prDiffs[num]) return;
    const account = useAccounts.getState().repoAccountRef;
    set((s) => ({ prDiffLoading: true, prDiffError: omit(s.prDiffError, num) }));
    try {
      const diffs = await api.pullRequestDiff(summary.path, num, account);
      set((s) => ({ prDiffs: { ...s.prDiffs, [num]: diffs }, prDiffLoading: false }));
    } catch (e) {
      set((s) => ({
        prDiffLoading: false,
        prDiffError: { ...s.prDiffError, [num]: String(e) },
      }));
    }
  },

  // Lazily loaded (GraphQL review threads) and cached by number.
  loadPrThreads: async (num, force) => {
    const summary = useRepo.getState().summary;
    if (!summary) return;
    if (!force && get().prThreads[num]) return;
    const account = useAccounts.getState().repoAccountRef;
    set((s) => ({ prThreadsLoading: true, prThreadsError: omit(s.prThreadsError, num) }));
    try {
      const threads = await api.pullRequestReviewThreads(summary.path, num, account);
      set((s) => ({ prThreads: { ...s.prThreads, [num]: threads }, prThreadsLoading: false }));
    } catch (e) {
      set((s) => ({
        prThreadsLoading: false,
        prThreadsError: { ...s.prThreadsError, [num]: String(e) },
      }));
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
      { action: "merge" },
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
      { action: "comment" },
    );
    await get().loadPrDetail(num, true);
    return out;
  },

  reviewPr: async (num, action, body) => {
    const out = await runPrAction(
      (path, account) => api.reviewPullRequest(path, num, action, body, account),
      { action: "review" },
    );
    await get().loadPrDetail(num, true);
    void get().loadPrChecks(num, true);
    return out;
  },

  setPrState: async (num, action) => {
    const out = await runPrAction(
      (path, account) => api.setPullRequestState(path, num, action, account),
      { action: "state" },
    );
    await get().loadPullRequests(true);
    await get().loadPrDetail(num, true);
    return out;
  },

  createPr: async (base, head, title, body, draft) => {
    const out = await runPrAction(
      (path, account) => api.createPullRequest(path, base, head, title, body, draft, account),
      { action: "create" },
    );
    await get().loadPullRequests(true);
    return out;
  },
}));

// Drop one numeric key from a record without mutating it (used to clear a PR's
// per-resource error when its load is retried).
function omit<V>(map: Record<number, V>, key: number): Record<number, V> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

function hasNumericKeys(map: Record<number, unknown>): boolean {
  return Object.keys(map).length > 0;
}

// A cached detail is stale if its PR vanished from the refreshed list or any
// summary-level field changed: state/draft (header Open/Merge controls), title/
// base/branch (header), or additions/deletions (new commits pushed — the Diff/
// Commits tabs would otherwise stay stale). All of these are returned by both
// `gh pr list` and `gh pr view`, so an unchanged PR never falsely invalidates.
// `mergeable` is intentionally excluded — list summaries don't carry it (it maps
// to ""), so comparing it would drop every cached detail on each refresh.
function detailMatchesSummary(detail: PullRequest, summary: PullRequest): boolean {
  return (
    detail.state === summary.state &&
    detail.draft === summary.draft &&
    detail.title === summary.title &&
    detail.base === summary.base &&
    detail.branch === summary.branch &&
    detail.add === summary.add &&
    detail.del === summary.del
  );
}

// On a non-force list refresh, keep only the cached details whose refreshed
// summary still matches; drop the rest so the detail effect (keyed on
// prsFetchedAt) refetches them instead of showing stale Open/Merge controls.
function prunePrDetails(
  cached: Record<number, PullRequest>,
  summaries: PullRequest[],
): Record<number, PullRequest> {
  const byNum = new Map(summaries.map((p) => [p.num, p]));
  const next: Record<number, PullRequest> = {};
  for (const [key, detail] of Object.entries(cached)) {
    const num = Number(key);
    const summary = byNum.get(num);
    if (summary && detailMatchesSummary(detail, summary)) next[num] = detail;
  }
  return next;
}

function prListRequestKey(path: string, account: GithubAccountRef | null): string {
  const accountKey = account
    ? `${account.provider}:${account.host}:${account.accountId}:${account.login}`
    : "default";
  return `${path}\0${accountKey}`;
}

// Repo + bound account identity of the currently-open repo, or null when none.
function currentPrListRequestKey(): string | null {
  const summary = useRepo.getState().summary;
  if (!summary) return null;
  return prListRequestKey(summary.path, useAccounts.getState().repoAccountRef);
}

function isCurrentPrListRequest(requestId: number, path: string): boolean {
  const state = usePulls.getState();
  return state.prsRefreshRequestId === requestId && useRepo.getState().summary?.path === path;
}

// A checks response is still current only if its request id is the latest for the
// PR AND the repo+account it was fetched under is still the bound one — otherwise
// a response fetched under a previous account could pin stale checks in the cache.
function isCurrentPrChecksRequest(
  state: PullsState,
  num: number,
  requestId: number,
  key: string,
): boolean {
  return state.prChecksLoadingByNum[num] === requestId && currentPrListRequestKey() === key;
}

function mergeQueuedPrListLoad(
  current: QueuedPrListLoad | null,
  next: QueuedPrListLoad,
): QueuedPrListLoad | null {
  if (!current) return next;
  return {
    force: current.force || next.force,
    quiet: current.quiet && next.quiet,
    waiters: [...current.waiters, ...next.waiters],
  };
}

// Settle a queued load after its re-run completed: resolve each waiter whose
// requested key still matches the current repo+account, and cancel the rest (the
// load ran under a different identity than they asked for). Per-waiter because
// coalescing keeps older waiters across an account/repo change.
function settleQueuedPrListLoad(queued: QueuedPrListLoad | null, currentKey: string | null): void {
  queued?.waiters.forEach((waiter) => {
    if (waiter.key === currentKey) waiter.resolve();
    else if (waiter.force) waiter.reject(new Error("PR list refresh canceled."));
    else waiter.resolve();
  });
}

// Cancel a queued load (repo switch/reset/inner error): reject the awaited force
// waiters so callers like mergePr/setPrState don't run repo-dependent follow-ups,
// but resolve fire-and-forget non-force reloads so a normal navigation doesn't
// surface an unhandled promise rejection.
function cancelQueuedPrListLoad(queued: QueuedPrListLoad | null, reason: unknown): void {
  queued?.waiters.forEach((waiter) => (waiter.force ? waiter.reject(reason) : waiter.resolve()));
}

// Shared body for PR write ops: require an open repo, run the call pinned to the
// bound account, and surface gh's output. Rejects (for the caller to toast) when
// there's no repo or gh errors. `trackPending` toggles the global PR action flag;
// review-thread actions pass `false` because they render inside independent cards
// and own their pending state locally (one busy thread must not disable the rest).
async function runPrAction(
  body: (path: string, account: GithubAccountRef | null) => Promise<string>,
  { action, trackPending = true }: { action?: PrPendingAction; trackPending?: boolean } = {},
): Promise<string> {
  const summary = useRepo.getState().summary;
  if (!summary) throw new Error("No repository");
  const account = useAccounts.getState().repoAccountRef;
  if (!trackPending || !action) return await body(summary.path, account);
  // Write errors surface via the caller's toast, not `prError` (which is the
  // list-load error and must not be cleared/clobbered by a write op). Track the
  // action in a multiset so concurrent writes are independent: one finishing
  // removes only its own entry, never clearing another action's busy state.
  usePulls.setState((s) => ({ prPendingActions: [...s.prPendingActions, action] }));
  try {
    return await body(summary.path, account);
  } finally {
    usePulls.setState((s) => {
      const i = s.prPendingActions.indexOf(action);
      return i === -1
        ? {}
        : { prPendingActions: [...s.prPendingActions.slice(0, i), ...s.prPendingActions.slice(i + 1)] };
    });
  }
}
