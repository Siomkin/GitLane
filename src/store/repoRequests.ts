// Request coordination for the repo store: the generation/intent tokens and the
// deferred-refresh queue that keep overlapping opens, refreshes, watcher
// re-syncs, and "load more" from clobbering each other. Pure module state — no
// Zustand, no IPC (selection.ts-style module); the store layers its summary-path
// and refresh glue on top (graphRequestIsCurrent / flushPendingRefresh).

// Graph-bearing requests (watcher refresh, explicit refresh, load more, repo
// switch) can overlap; only the newest may publish graph-derived state.
let graphRequestGeneration = 0;
export const beginGraphRequest = (): number => ++graphRequestGeneration;
export const graphGenerationIsCurrent = (generation: number): boolean =>
  generation === graphRequestGeneration;

// Ordering token claimed at the very start of every loadRepo, before the
// (possibly slow) open. A newer pick increments it, so a slower earlier open that
// resolves later loses the race — it can neither publish its summary over, nor
// surface an error on, the repo the user actually landed on. Distinct from the
// graph generation: a failed open must NOT bump that (it would orphan an
// unrelated in-flight graph), but it still has to lose this ordering race.
let openIntentGeneration = 0;
export const claimOpenIntent = (): number => ++openIntentGeneration;
export const openIntentIsCurrent = (intent: number): boolean =>
  intent === openIntentGeneration;
// Read the current open intent *without* claiming a new one. A follow-up that
// awaits between failure detection and publishing (the removed-worktree
// fallback's disk probe) captures this first, then re-checks it after: a repo
// switch initiated in that window has already claimed a newer intent — before
// its summary/graph generation catch up — so this is what flips first.
export const currentOpenIntent = (): number => openIntentGeneration;

// Identity of each live repository tab. Unlike the global open intent, these
// leases are path-scoped: closing an unrelated background tab must not cancel a
// pending open, while closing and reopening the *same* path must give it a new
// identity so an old activation/probe cannot publish into the replacement tab
// (the same-path ABA case).
//
// The map contains live tabs only. Restored/pre-existing tabs are registered
// lazily when an async action first needs a lease; genuinely new tabs call
// beginTabLifetime in the same synchronous publication that adds the path, and
// every removal/re-key calls endTabLifetime before mutating persisted/UI state.
let nextTabLifetime = 0;
const tabLifetimeByPath = new Map<string, number>();

export interface TabLifetimeLease {
  path: string;
  lifetime: number;
}

/** Capture the lifetime of an existing live tab, registering it lazily. */
export const ensureTabLifetime = (path: string): TabLifetimeLease => {
  let lifetime = tabLifetimeByPath.get(path);
  if (lifetime === undefined) {
    lifetime = ++nextTabLifetime;
    tabLifetimeByPath.set(path, lifetime);
  }
  return { path, lifetime };
};

/** Publish a fresh lifetime for a newly-added/re-keyed tab. */
export const beginTabLifetime = (path: string): TabLifetimeLease => {
  const lifetime = ++nextTabLifetime;
  tabLifetimeByPath.set(path, lifetime);
  return { path, lifetime };
};

/** End only this path's live tab lifetime. A future reopen gets a new ID. */
export const endTabLifetime = (path: string): void => {
  tabLifetimeByPath.delete(path);
};

export const tabLifetimeIsCurrent = (lease: TabLifetimeLease): boolean =>
  tabLifetimeByPath.get(lease.path) === lease.lifetime;

// Identity of the repository session that is actually published in the store.
// Unlike openIntentGeneration this advances only beside the phase-2 summary
// publication (or an active-summary clear), so a write started while a newer
// open is still probing cannot accidentally inherit that pending open's intent.
// The path remains part of callers' owner keys; this generation closes the
// same-path close/reopen ABA hole.
let publishedRepoSessionGeneration = 0;
let prMetadataReady: {
  session: number;
  generation: number;
  canPrefetch: boolean;
} | null = null;
let prRemotesReady: { session: number; generation: number } | null = null;
let claimedPrPrefetchKey: string | null = null;
let requestedPrPrefetchSession: number | null = null;

export const beginPublishedRepoSession = (): number => {
  publishedRepoSessionGeneration += 1;
  prMetadataReady = null;
  prRemotesReady = null;
  claimedPrPrefetchKey = null;
  requestedPrPrefetchSession = null;
  return publishedRepoSessionGeneration;
};
export const currentPublishedRepoSession = (): number => publishedRepoSessionGeneration;
export const publishedRepoSessionIsCurrent = (generation: number): boolean =>
  generation === publishedRepoSessionGeneration;

// Secondary reads are split into independent latest-request lanes. A full
// refresh can supersede the working-tree snapshot without cancelling a still
// useful metadata read (and vice versa), while requests in the same lane are
// strictly latest-started-wins. Callers combine these tokens with the published
// repo session + path in repoGuards.ts, closing same-path close/reopen ABA races.
let metadataRequestGeneration = 0;
export const beginMetadataRequest = (): number => {
  prMetadataReady = null;
  return ++metadataRequestGeneration;
};
export const metadataGenerationIsCurrent = (generation: number): boolean =>
  generation === metadataRequestGeneration;

let worktreeRequestGeneration = 0;
export const beginWorktreeRequest = (): number => ++worktreeRequestGeneration;
export const worktreeGenerationIsCurrent = (generation: number): boolean =>
  generation === worktreeRequestGeneration;

let remotesRequestGeneration = 0;
export const beginRemotesRequest = (): number => {
  prRemotesReady = null;
  return ++remotesRequestGeneration;
};
export const remotesGenerationIsCurrent = (generation: number): boolean =>
  generation === remotesRequestGeneration;

/** Mark a terminal forge/remotes publication for the current owner pair. */
export const markMetadataReadyForPr = (
  session: number,
  generation: number,
  canPrefetch: boolean,
): void => {
  if (
    publishedRepoSessionIsCurrent(session) &&
    metadataGenerationIsCurrent(generation)
  ) {
    prMetadataReady = { session, generation, canPrefetch };
  }
};

export const markRemotesReadyForPr = (session: number, generation: number): void => {
  if (
    publishedRepoSessionIsCurrent(session) &&
    remotesGenerationIsCurrent(generation)
  ) {
    prRemotesReady = { session, generation };
  }
};

/** Claim one quiet PR prefetch for the winning metadata/remotes owner pair. */
export const requestPrPrefetch = (session: number): void => {
  if (publishedRepoSessionIsCurrent(session)) requestedPrPrefetchSession = session;
};

export const claimPrPrefetch = (session: number): boolean => {
  if (
    !publishedRepoSessionIsCurrent(session) ||
    requestedPrPrefetchSession !== session
  ) {
    return false;
  }
  if (
    prMetadataReady?.session !== session ||
    prMetadataReady.generation !== metadataRequestGeneration ||
    prRemotesReady?.session !== session ||
    prRemotesReady.generation !== remotesRequestGeneration
  ) {
    return false;
  }
  requestedPrPrefetchSession = null;
  if (!prMetadataReady.canPrefetch) return false;
  const key = `${session}:${prMetadataReady.generation}:${prRemotesReady.generation}`;
  if (claimedPrPrefetchKey === key) return false;
  claimedPrPrefetchKey = key;
  return true;
};

let reflogRequestGeneration = 0;
export const beginReflogRequest = (): number => ++reflogRequestGeneration;
export const reflogGenerationIsCurrent = (generation: number): boolean =>
  generation === reflogRequestGeneration;

export type RefreshScope = "all" | "worktree";

// A passive re-sync (filesystem watcher / focus) requested while `loading` was
// held by an in-flight load or a manual refresh. Coalesced to the most permissive
// scope and replayed once the blocker clears — so external commits/checkouts/
// staging during a slow graph load aren't silently dropped. Deferring (rather than
// running inline) also avoids racing the load's own working-changes read.
let pendingRefresh: RefreshScope | null = null;
/** Queue a deferred re-sync, widening the pending scope ("all" dominates). */
export const deferRefresh = (scope: RefreshScope): void => {
  pendingRefresh = scope === "all" || pendingRefresh === "all" ? "all" : "worktree";
};
/** Take and clear the pending scope (null when nothing is queued). */
export const takePendingRefresh = (): RefreshScope | null => {
  const scope = pendingRefresh;
  pendingRefresh = null;
  return scope;
};
