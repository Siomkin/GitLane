// Pull-request state for the open repo: the list plus the per-number detail and
// checks caches. Split out of `useRepo` so PR consumers don't re-render on git
// graph churn, and vice versa. Resolves the repo path + bound account lazily via
// the other stores; server-side token resolution stays behind the provider boundary.

import { create } from "zustand";

import {
  api,
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
  /** Detail cache by PR number (body, files) — re-opening a PR is instant. */
  prDetails: Record<number, PullRequest>;
  prDetailLoading: boolean;
  /** Per-PR detail-load error (so the detail body can retry, not blank the list). */
  prDetailError: Record<number, string>;
  /** Lazily-loaded checks cache by PR number (the slow statusCheckRollup). */
  prChecks: Record<number, PrCheck[]>;
  prChecksLoading: boolean;
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
  /** True while a write op (merge/comment/review/state/create) is in flight. */
  prActionPending: boolean;

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
  prDetails: {},
  prDetailLoading: false,
  prDetailError: {},
  prChecks: {},
  prChecksLoading: false,
  prChecksError: {},
  prDiffs: {},
  prDiffLoading: false,
  prDiffError: {},
  prThreads: {},
  prThreadsLoading: false,
  prThreadsError: {},
  prCommitSigsLoaded: {},
  prCommitSigsError: {},
  prActionPending: false,

  reset: () =>
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
      prError: null,
      prsLoading: false,
    }),

  // Fetch the repo's PRs via `gh`, pinned to the bound account when set.
  // Failures (gh missing, no GitHub remote, not logged in) surface as `prError`
  // and leave the list empty — never throw into the UI.
  loadPullRequests: async (force, quiet) => {
    const summary = useRepo.getState().summary;
    if (!summary) {
      set({ pullRequests: [], prError: null });
      return;
    }
    const account = useAccounts.getState().repoAccountRef;
    set({
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
          }
        : {}),
    });
    const path = summary.path;
    try {
      const list = await api.listPullRequests(path, account);
      // Bail if the repo switched while this load was in flight, so a slow fetch
      // can't clobber the new repo's PR state.
      if (useRepo.getState().summary?.path !== path) return;
      set({ pullRequests: list.map(summaryToPr), prsLoading: false, prsFetchedAt: Date.now() });
    } catch (e) {
      if (useRepo.getState().summary?.path !== path) return;
      set({ pullRequests: [], prsLoading: false, prError: String(e) });
    }
  },

  // Force-refresh: drop caches and refetch the list. The detail/checks views
  // re-fetch on their own because their effects key off `prsFetchedAt`.
  refreshPullRequests: async () => {
    await get().loadPullRequests(true);
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
    if (!force && get().prChecks[num]) return;
    const account = useAccounts.getState().repoAccountRef;
    set((s) => ({ prChecksLoading: true, prChecksError: omit(s.prChecksError, num) }));
    try {
      const checks = await api.pullRequestChecks(summary.path, num, account);
      set((s) => ({ prChecks: { ...s.prChecks, [num]: checks }, prChecksLoading: false }));
    } catch (e) {
      set((s) => ({
        prChecksLoading: false,
        prChecksError: { ...s.prChecksError, [num]: String(e) },
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
    const out = await runPrAction((path, account) =>
      api.resolveReviewThread(path, threadId, resolved, account),
    );
    await get().loadPrThreads(num, true);
    return out;
  },

  mergePr: async (num, method, deleteBranch) => {
    const out = await runPrAction((path, account) =>
      api.mergePullRequest(path, num, method, deleteBranch, account),
    );
    // State + checked-out branch can both change; reload the list and this PR.
    await get().loadPullRequests(true);
    await get().loadPrDetail(num, true);
    void useRepo.getState().refresh({ prs: false });
    return out;
  },

  commentPr: async (num, body) => {
    const out = await runPrAction((path, account) =>
      api.commentPullRequest(path, num, body, account),
    );
    await get().loadPrDetail(num, true);
    return out;
  },

  reviewPr: async (num, action, body) => {
    const out = await runPrAction((path, account) =>
      api.reviewPullRequest(path, num, action, body, account),
    );
    await get().loadPrDetail(num, true);
    void get().loadPrChecks(num, true);
    return out;
  },

  setPrState: async (num, action) => {
    const out = await runPrAction((path, account) =>
      api.setPullRequestState(path, num, action, account),
    );
    await get().loadPullRequests(true);
    await get().loadPrDetail(num, true);
    return out;
  },

  createPr: async (base, head, title, body, draft) => {
    const out = await runPrAction((path, account) =>
      api.createPullRequest(path, base, head, title, body, draft, account),
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

// Shared body for PR write ops: require an open repo, toggle the pending flag,
// run the call pinned to the bound account, and surface gh's output. Rejects
// (for the caller to toast) when there's no repo or gh errors.
async function runPrAction(
  body: (path: string, account: GithubAccountRef | null) => Promise<string>,
): Promise<string> {
  const summary = useRepo.getState().summary;
  if (!summary) throw new Error("No repository");
  const account = useAccounts.getState().repoAccountRef;
  // Write errors surface via the caller's toast, not `prError` (which is the
  // list-load error and must not be cleared/clobbered by a write op).
  usePulls.setState({ prActionPending: true });
  try {
    return await body(summary.path, account);
  } finally {
    usePulls.setState({ prActionPending: false });
  }
}
