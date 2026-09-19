// The one sanctioned channel for a store to reach a store ABOVE it.
//
// Stores import only downward — leaves < ui < accounts < pulls < identities <
// repo (architecture-rules-react.md §1 "Import direction"). A lower store still
// legitimately needs two things from above: which repo is open right now, and
// "refresh yourself, I changed something you show". Importing the higher store
// for that closes a module cycle, so those needs are late-bound here instead:
// this module imports nothing at runtime, and `repo.ts` / `pulls.ts` assign the
// real implementations right after `create()`.
//
// Capped at these four entries (links.test.ts pins the keys). Anything richer
// belongs in the higher store, calling down.
//
// `openRepo` is a live getter, not a copy: call it at the point you need the
// value. Never hold its result across an `await` — the post-await "is this
// still the open repo?" guards depend on re-reading it.

import type { PullsState } from "./pulls";
import type { RepoState } from "./repoTypes";

/** The three repo fields lower stores read. */
export type OpenRepoSnapshot = Pick<RepoState, "summary" | "remotes" | "forge">;

export interface StoreLinks {
  openRepo: () => OpenRepoSnapshot;
  refreshRepo: RepoState["refresh"];
  listRemotes: RepoState["listRemotes"];
  reloadPulls: PullsState["loadPullRequests"];
}

// Unbound defaults: no repo open, refreshes are no-ops. That is what a store
// under test sees unless the test binds a link (or imports the store above).
export const storeLinks: StoreLinks = {
  openRepo: () => ({ summary: null, remotes: [], forge: null }),
  refreshRepo: async () => false,
  listRemotes: async () => [],
  reloadPulls: async () => {},
};
