// One lazy per-PR resource load (GL-349), over one normalized resource record
// (GL-364). The store's five per-PR resources — detail, checks, diff, threads,
// commits — differ only in which provider call they make and what they cache;
// everything else is the same staleness story:
//
//   claim this PR's request slot → fetch → on settle, publish ONLY while the
//   claim still holds, the repo+account is the one fetched under, and no refresh
//   bumped this PR's cache generation mid-flight.
//
// Three copies of that story had drifted apart before GL-349; after it, each
// resource still owned a hand-named field family (data/slots/error/derived
// flag), so the loader needed four callbacks just to find its own state, and
// the initializer, reset, and refresh-prune each enumerated ~20 fields by hand.
// The record below is the single shape they all share: the loader addresses
// state by `kind`, and clearing every per-PR resource is one field write.
//
// Not pure (unlike `pullsCache`/`pullsQueue`): resolving "which repo + account is
// current" is the staleness question, so this module reads those stores, like
// `pullsActionOwner` does for writes.

import type { FileDiff, GithubAccountRef, PrCheck, ReviewThread } from "@/lib/api";
import type { PullRequest } from "@/lib/prs";
import { useAccounts } from "./accounts";
import { useRepo } from "./repo";
import { prListRequestKey } from "./pullsQueue";
import { claimPrRequestId, ownsPrRequest } from "./pullsRequests";

/** Repo + bound account identity of the currently-open repo, or null when none. */
export function currentPrListRequestKey(): string | null {
  const summary = useRepo.getState().summary;
  if (!summary) return null;
  return prListRequestKey(summary.path, useAccounts.getState().prAccountRef());
}

/** The lazily-loaded per-PR resources. Compare against these consts, never the
 * raw strings. */
export const PR_RESOURCE = {
  Detail: "detail",
  Checks: "checks",
  Diff: "diff",
  Threads: "threads",
  Commits: "commits",
} as const;
export type PrResourceKind = (typeof PR_RESOURCE)[keyof typeof PR_RESOURCE];

export const PR_RESOURCE_KINDS = Object.values(PR_RESOURCE) as PrResourceKind[];

/** Inline review threads plus whether the walk hit the backend page cap. */
export interface PrThreadsPayload {
  threads: ReviewThread[];
  truncated: boolean;
}

/** Marker that the full verified commit list (paginated GraphQL) has replaced
 * the cached detail's capped `gh pr view` commits — the commits themselves live
 * on the detail. Presence means "applied, don't re-run"; `truncated` records
 * whether the walk hit the backend page cap. */
export interface PrCommitsMarker {
  truncated: boolean;
}

/** What each resource caches per PR number. */
export interface PrResourcePayloads {
  detail: PullRequest;
  checks: PrCheck[];
  diff: FileDiff[];
  threads: PrThreadsPayload;
  commits: PrCommitsMarker;
}

/** One resource's per-PR state: the cache, the in-flight request slots
 * (request-owned, GL-166), and the per-PR load errors. */
export interface PrResourceState<K extends PrResourceKind = PrResourceKind> {
  data: Record<number, PrResourcePayloads[K]>;
  slots: Record<number, number>;
  errors: Record<number, string>;
}

export type PrResources = { [K in PrResourceKind]: PrResourceState<K> };

// Function declarations (not const arrows): the store evaluates these at
// module-initialization inside an import cycle (pulls → repo → pulls…), where
// only hoisted declarations are callable.
function emptyResource<K extends PrResourceKind>(): PrResourceState<K> {
  return { data: {}, slots: {}, errors: {} };
}

export function emptyPrResources(): PrResources {
  return {
    detail: emptyResource(),
    checks: emptyResource(),
    diff: emptyResource(),
    threads: emptyResource(),
    commits: emptyResource(),
  };
}

/** Immutable per-kind patch of the resource record. */
export function patchPrResource<K extends PrResourceKind>(
  resources: PrResources,
  kind: K,
  patch: Partial<PrResourceState<K>>,
): PrResources {
  return { ...resources, [kind]: { ...resources[kind], ...patch } };
}

/** The store fields every per-PR resource shares — a structural subset, so this
 * module never imports the store itself. */
export interface PrResourceSlice {
  prResources: PrResources;
  prResourceVersion: Record<number, number>;
}

/** What one resource contributes on top of the shared staleness rules. */
export interface PrResourceSpec<K extends PrResourceKind, T, S extends PrResourceSlice> {
  kind: K;
  num: number;
  /** Reload even when the cache is warm. */
  force?: boolean;
  /** Already cached (or already loading) — nothing to do unless forced.
   * Defaults to "this resource has data for this PR". */
  skip?: (s: S) => boolean;
  fetch: (path: string, num: number, account: GithubAccountRef | null) => Promise<T>;
  /** Store patch caching the fetched value. Defaults to writing it into this
   * resource's own data map (so `T` must be the payload). Overridden by loads
   * with side-writes — the detail also lands its stack and re-arms the commits
   * marker; the commits load patches the cached detail (and publishes `{}` when
   * that detail was evicted mid-flight). */
  publish?: (s: S, value: T) => Partial<S>;
}

// Drop one numeric key from a record without mutating it.
export function omit<V>(map: Record<number, V>, key: number): Record<number, V> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

// Drop several numeric keys from a record without mutating it (returns the same
// reference when nothing is dropped, so unrelated refreshes don't re-render —
// including when the keys simply aren't in the map, e.g. a stale PR that only
// ever appeared in the previous list; GL-161 review).
export function omitMany<V>(map: Record<number, V>, keys: number[]): Record<number, V> {
  if (!keys.some((k) => k in map)) return map;
  const next = { ...map };
  for (const k of keys) delete next[k];
  return next;
}

/** Evict a set of PRs from every resource — cache, errors, and in-flight
 * request slots, so a stale request drops on settle (slot mismatch, GL-166)
 * and any per-PR spinner clears NOW instead of waiting for the stale network
 * call to return. One deliberate exception: the **commits** loads keep their
 * slots — two commits loads may overlap in one generation (the Commits tab's
 * prsFetchedAt-keyed effect re-runs without a version bump) and only the
 * newest may publish, so the slot must stay owned; the version bump the
 * callers pair with this eviction is what discards their writes (GL-164). */
export function evictPrResources(resources: PrResources, nums: number[]): PrResources {
  let next = resources;
  for (const kind of PR_RESOURCE_KINDS) {
    next = evictFromResource(next, kind, nums);
  }
  return next;
}

function evictFromResource<K extends PrResourceKind>(
  resources: PrResources,
  kind: K,
  nums: number[],
): PrResources {
  const resource = resources[kind];
  const data = omitMany(resource.data, nums);
  const errors = omitMany(resource.errors, nums);
  const slots = kind === PR_RESOURCE.Commits ? resource.slots : omitMany(resource.slots, nums);
  // Preserve references when nothing changed so unrelated refreshes don't
  // re-render subscribers of this resource.
  if (data === resource.data && errors === resource.errors && slots === resource.slots)
    return resources;
  return patchPrResource(resources, kind, { data, errors, slots });
}

/** Fresh resource record for a forced list reload: every cache, error, and
 * in-flight slot cleared — with the same commits-slot exception as
 * [`evictPrResources`], for the same reason. */
export function clearPrResources(resources: PrResources): PrResources {
  return {
    ...emptyPrResources(),
    commits: { ...emptyResource<typeof PR_RESOURCE.Commits>(), slots: resources.commits.slots },
  };
}

export async function loadPrResource<K extends PrResourceKind, T, S extends PrResourceSlice>(
  set: (patch: (s: S) => Partial<S>) => void,
  get: () => S,
  spec: PrResourceSpec<K, T, S>,
): Promise<void> {
  const { kind, num, force, fetch } = spec;
  const summary = useRepo.getState().summary;
  if (!summary) return;
  const skip = spec.skip ?? ((s: S) => num in s.prResources[kind].data);
  if (!force && skip(get())) return;
  const account = useAccounts.getState().prAccountRef();
  // Pin the response to the repo+account it was fetched under and to this PR's
  // cache generation (a refresh prune bumps it mid-flight).
  const key = prListRequestKey(summary.path, account);
  const version = get().prResourceVersion[num] ?? 0;
  // Claim this PR's slot: only the current owner may publish or clear loading,
  // so a repo switch (reset empties the map) or a newer/forced load orphans this
  // request instead of letting it write into the fresh state (GL-166).
  const requestId = claimPrRequestId();
  set((s) => ({
    prResources: patchPrResource(s.prResources, kind, {
      slots: { ...s.prResources[kind].slots, [num]: requestId },
      errors: omit(s.prResources[kind].errors, num),
    }),
  }) as Partial<S>);

  // Settle: release our own slot, and write only while the response is still
  // the one this repo+account+generation asked for.
  const settle = (write: (s: S) => Partial<S>) =>
    set((s) => {
      // Superseded by a newer request or orphaned by a reset/prune → the slot is
      // someone else's now; touch nothing.
      if (!ownsPrRequest(s.prResources[kind].slots, num, requestId)) return {};
      const released = {
        prResources: patchPrResource(s.prResources, kind, {
          slots: omit(s.prResources[kind].slots, num),
        }),
      } as Partial<S>;
      if (currentPrListRequestKey() !== key || (s.prResourceVersion[num] ?? 0) !== version)
        return released;
      // Let `write` see the slot-released record so its own resource patches
      // compose (spread order: write's `prResources` wins when it patches).
      return { ...released, ...write({ ...s, ...released }) };
    });

  const publish =
    spec.publish ??
    ((s: S, value: T) => ({
      prResources: patchPrResource(s.prResources, kind, {
        data: {
          ...s.prResources[kind].data,
          [num]: value as unknown as PrResourcePayloads[K],
        },
      }),
    }) as Partial<S>);

  try {
    const value = await fetch(summary.path, num, account);
    settle((s) => publish(s, value));
  } catch (e) {
    settle((s) => ({
      prResources: patchPrResource(s.prResources, kind, {
        errors: { ...s.prResources[kind].errors, [num]: String(e) },
      }),
    }) as Partial<S>);
  }
}
