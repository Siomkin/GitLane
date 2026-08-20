// Pull-request state for the open repo: the list plus the per-number detail and
// checks caches. Split out of `useRepo` so PR consumers don't re-render on git
// graph churn, and vice versa. Resolves the repo path + bound account lazily via
// the other stores; server-side token resolution stays behind the provider boundary.
//
// This file declares the state and composes the actions; they live under
// `pulls/` by responsibility — the list load, the lazy per-PR resources, and
// the writes.

import { create, type StoreApi } from "zustand";

import type {
  MergeMethod,
  PrCreateInput,
  PrReviewerCandidate,
  PrStack,
  PrStackMembership,
  PrStateAction,
} from "@/lib/api";
import type { PrSummary } from "@/lib/prs";
import type { QueuedPrListLoad } from "./pullsQueue";
import { emptyPrResources, type PrResources } from "./pullsResource";
import { createPrListActions } from "./pulls/list";
import { createPrResourceActions } from "./pulls/resources";
import { createPrWriteActions, type PrPendingAction } from "./pulls/writes";
export {
  PR_PENDING_ACTION,
  anyPrActionPending,
  isPrActionPending,
  type PrPendingAction,
  type PrPendingActionKind,
} from "./pulls/writes";

export interface PullsState {
  /** Pull requests for the open repo (from `gh`, via the bound account) —
   * summaries; the full details live in `prResources.detail`. */
  pullRequests: PrSummary[];
  prsLoading: boolean;
  /**
   * List-load error only (gh missing, no GitHub remote, not logged in). Scoped
   * to the list so a single PR's detail/diff/checks/threads failure can't blank
   * the sidebar — those surface in the per-PR error maps below instead.
   */
  prError: string | null;
  /** Epoch ms when the PR list was last successfully fetched (for "updated …"). */
  prsFetchedAt: number | null;
  /** Active PR-list fetch. `null` when idle; `requestId` so stale completions
   * no-op; `key` is the repo/account identity of the fetch. */
  prsRefresh: { requestId: number; key: string } | null;
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

  // ---- Write actions. Each runs via the bound account, refreshes the affected
  // caches, and resolves with gh's output (or rejects so the caller can toast). ----

  /** Merge a PR (`gh pr merge`), optionally deleting the head branch. Resolves
   * with an empty string — the outcome is reported as a toast, not returned
   * (GL-345); the shared runner only reads resolution as a success signal. */
  mergePr: (num: number, method: MergeMethod, deleteBranch: boolean) => Promise<string>;
  /** Atomically merge this PR and every unmerged layer below it in its stack.
   * All-or-nothing: if any layer can't merge, none of them do. */
  mergeStack: (num: number, method: MergeMethod) => Promise<string>;
  /** Submit a bodyless approval, then refresh detail and checks. */
  approvePr: (num: number) => Promise<string>;
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

export type PullsSet = StoreApi<PullsState>["setState"];
export type PullsGet = StoreApi<PullsState>["getState"];

export const usePulls = create<PullsState>((set, get) => ({
  pullRequests: [],
  prsLoading: false,
  prError: null,
  prsFetchedAt: null,
  prsRefresh: null,
  prsRefreshQueued: null,
  prResources: emptyPrResources(),
  prStackBadges: {},
  prStacks: {},
  prResourceVersion: {},
  prPendingActions: [],

  ...createPrListActions(set, get),
  ...createPrResourceActions(set, get),
  ...createPrWriteActions(get),
}));
