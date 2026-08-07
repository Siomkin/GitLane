// Per-PR cache maintenance for the pulls store (GL-161 split out of pulls.ts):
// the cache-generation bump that invalidates in-flight loads, and the staleness
// rules that evict a PR's resources when a list refresh shows its summary
// changed. Pure — no Zustand, no IPC; the store passes its state in
// (PullsState structurally satisfies `PrCacheSlice`). The resource record and
// its eviction mechanics live in `pullsResource` (GL-364); this module owns the
// *policy* — which PRs are stale.

import type { PrStack } from "@/lib/api";
import type { PullRequest } from "@/lib/prs";
import {
  evictPrResources,
  omitMany,
  PR_RESOURCE_KINDS,
  type PrResources,
} from "./pullsResource";

/** The cache fields of `PullsState` these rules read/write — a structural
 * subset so this module never imports the store. */
export interface PrCacheSlice {
  pullRequests: PullRequest[];
  prStacks: Record<number, PrStack>;
  prResources: PrResources;
  prResourceVersion: Record<number, number>;
}

// Increment the cache generation for each PR, so any load that captured the old
// value discards its write (same reference when nothing changes).
export function bumpResourceVersions(
  versions: Record<number, number>,
  nums: number[],
): Record<number, number> {
  if (nums.length === 0) return versions;
  const next = { ...versions };
  for (const n of nums) next[n] = (next[n] ?? 0) + 1;
  return next;
}

// Every PR number the store currently knows about — cached, in-flight (the
// per-PR request slots, GL-166), or in the (previous) list. Used to invalidate
// in-flight loads on a forced refresh.
export function knownPrNums(s: PrCacheSlice): number[] {
  return [
    ...new Set<number>(
      [
        ...PR_RESOURCE_KINDS.flatMap((kind) => [
          ...Object.keys(s.prResources[kind].data),
          ...Object.keys(s.prResources[kind].slots),
        ]),
        ...Object.keys(s.prResourceVersion),
        ...s.pullRequests.map((p) => String(p.num)),
      ].map(Number),
    ),
  ];
}

// A cached detail is stale if its PR vanished from the refreshed list or any
// summary-level field changed: state/draft (header Open/Merge controls), title/
// base/branch (header), additions/deletions/changedFiles (new commits pushed —
// the Diff/Commits tabs would otherwise stay stale, even if net +/- is equal but
// files moved), or a definitive mergeable verdict (a base advance flipping
// Merge↔Conflicts). All are returned by both `gh pr list` and `gh pr view`, so an
// unchanged PR never falsely invalidates.
export function detailMatchesSummary(detail: PullRequest, summary: PullRequest): boolean {
  // Mergeability is compared only when the list reports a definitive verdict —
  // `gh pr list` returns "UNKNOWN" (or "") until GitHub computes it, so an
  // indefinite value is ignored to avoid dropping the cached detail every refresh.
  const mergeableChanged =
    (summary.mergeable === "MERGEABLE" || summary.mergeable === "CONFLICTING") &&
    summary.mergeable !== detail.mergeable;
  return (
    detail.state === summary.state &&
    detail.draft === summary.draft &&
    detail.title === summary.title &&
    detail.base === summary.base &&
    detail.branch === summary.branch &&
    detail.add === summary.add &&
    detail.del === summary.del &&
    detail.changedFiles === summary.changedFiles &&
    !mergeableChanged
  );
}

// On a non-force list refresh, evict every per-PR resource (detail, diff,
// checks, threads, commit markers, and their errors) for PRs that left the list
// or whose summary changed, so the prsFetchedAt-keyed tab effects refetch fresh
// data instead of showing a stale detail/diff/checks. Returns the cache fields
// to merge into the store (empty when nothing is stale, preserving references).
export function pruneStalePrCaches(s: PrCacheSlice, summaries: PullRequest[]): Partial<PrCacheSlice> {
  const byNum = new Map(summaries.map((p) => [p.num, p]));
  const prevByNum = new Map(s.pullRequests.map((p) => [p.num, p]));
  // Candidates: anything cached, any in-flight per-PR load (the request slots,
  // GL-166), OR in the previous list — the last covers a PR whose first load is
  // still in flight (no cache entry yet) so a changed summary still bumps its
  // version.
  const candidateNums = new Set<number>(
    [
      ...PR_RESOURCE_KINDS.flatMap((kind) => [
        ...Object.keys(s.prResources[kind].data),
        ...Object.keys(s.prResources[kind].slots),
      ]),
      ...s.pullRequests.map((p) => String(p.num)),
    ].map(Number),
  );
  const detailData = s.prResources.detail.data;
  const stale: number[] = [];
  for (const num of candidateNums) {
    const summary = byNum.get(num);
    if (!summary) {
      stale.push(num); // PR left the list
      continue;
    }
    // Baseline = the cached detail (richest) if loaded, else the previous list
    // summary; both carry the compared fields. Without either we can't tell.
    const baseline = detailData[num] ?? prevByNum.get(num);
    if (baseline && !detailMatchesSummary(baseline, summary)) stale.push(num);
  }
  if (stale.length === 0) return {};
  return {
    prResources: evictPrResources(s.prResources, stale),
    // The stack is fetched with the detail, so it goes stale with it — a PR
    // whose summary changed may have been merged out of (or added to) a stack.
    prStacks: omitMany(s.prStacks, stale),
    // Bump the cache generation so any in-flight load that captured the old
    // value discards its write (commits loads keep their slot — see
    // `evictPrResources` — so the version is what covers them).
    prResourceVersion: bumpResourceVersions(s.prResourceVersion, stale),
  };
}
