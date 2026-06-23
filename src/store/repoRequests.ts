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
