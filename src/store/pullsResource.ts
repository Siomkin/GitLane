// One lazy per-PR resource load (GL-349). The store's five per-PR resources —
// detail, checks, diff, threads, commits — differ only in which provider call
// they make and which cache keys they write; everything else is the same
// staleness story, and each used to carry its own copy of it:
//
//   claim this PR's request slot → fetch → on settle, publish ONLY while the
//   claim still holds, the repo+account is the one fetched under, and no refresh
//   bumped this PR's cache generation mid-flight.
//
// Three copies had drifted apart (two slot schemes, and the checks copy compared
// no resource version at all). The rules live here once, so there is no second
// copy to forget; the callers keep only what is genuinely theirs — the fetch,
// the skip condition, and the cache keys.
//
// Not pure (unlike `pullsCache`/`pullsQueue`): resolving "which repo + account is
// current" is the staleness question, so this module reads those stores, like
// `pullsActionOwner` does for writes.

import type { GithubAccountRef } from "@/lib/api";
import { useAccounts } from "./accounts";
import { useRepo } from "./repo";
import { omit } from "./pullsCache";
import { prListRequestKey } from "./pullsQueue";
import { claimPrRequestId, ownsPrRequest } from "./pullsRequests";

/** Repo + bound account identity of the currently-open repo, or null when none. */
export function currentPrListRequestKey(): string | null {
  const summary = useRepo.getState().summary;
  if (!summary) return null;
  return prListRequestKey(summary.path, useAccounts.getState().prAccountRef());
}

/** The one store field every per-PR resource shares — a structural subset, so
 * this module never imports the store itself. */
export interface PrResourceSlice {
  prResourceVersion: Record<number, number>;
}

/** What one resource contributes on top of the shared staleness rules. */
export interface PrResourceSpec<T, S extends PrResourceSlice> {
  num: number;
  /** Reload even when `skip` says the cache is warm. */
  force?: boolean;
  /** Already cached (or already loading) — nothing to do unless forced. */
  skip?: (s: S) => boolean;
  fetch: (path: string, num: number, account: GithubAccountRef | null) => Promise<T>;
  /** This resource's in-flight request slots, keyed by PR number. */
  slots: (s: S) => Record<number, number>;
  /** Store patch writing those slots back — plus any derived loading flag. The
   * commits load has no spinner, so it writes the map alone. */
  setSlots: (slots: Record<number, number>) => Partial<S>;
  /** Store patch recording this PR's load error, or clearing it for `null`. */
  setError: (s: S, message: string | null) => Partial<S>;
  /** Store patch caching the fetched value. Returns `{}` to publish nothing (the
   * commits load drops its result when the detail it patches was evicted). */
  publish: (s: S, value: T) => Partial<S>;
}

export async function loadPrResource<T, S extends PrResourceSlice>(
  set: (patch: (s: S) => Partial<S>) => void,
  get: () => S,
  { num, force, skip, fetch, slots, setSlots, setError, publish }: PrResourceSpec<T, S>,
): Promise<void> {
  const summary = useRepo.getState().summary;
  if (!summary) return;
  if (!force && skip?.(get())) return;
  const account = useAccounts.getState().prAccountRef();
  // Pin the response to the repo+account it was fetched under and to this PR's
  // cache generation (a refresh prune bumps it mid-flight).
  const key = prListRequestKey(summary.path, account);
  const version = get().prResourceVersion[num] ?? 0;
  // Claim this PR's slot: only the current owner may publish or clear loading,
  // so a repo switch (reset empties the map) or a newer/forced load orphans this
  // request instead of letting it write into the fresh state (GL-166).
  const requestId = claimPrRequestId();
  set((s) => ({ ...setSlots({ ...slots(s), [num]: requestId }), ...setError(s, null) }));

  // Settle: release our own slot, and write only while the response is still
  // the one this repo+account+generation asked for.
  const settle = (write: (s: S) => Partial<S>) =>
    set((s) => {
      // Superseded by a newer request or orphaned by a reset/prune → the slot is
      // someone else's now; touch nothing.
      if (!ownsPrRequest(slots(s), num, requestId)) return {};
      const released = setSlots(omit(slots(s), num));
      if (currentPrListRequestKey() !== key || (s.prResourceVersion[num] ?? 0) !== version)
        return released;
      return { ...released, ...write(s) };
    });

  try {
    const value = await fetch(summary.path, num, account);
    settle((s) => publish(s, value));
  } catch (e) {
    settle((s) => setError(s, String(e)));
  }
}
