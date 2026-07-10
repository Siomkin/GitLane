// Per-PR cache maintenance for the pulls store (GL-161 split out of pulls.ts):
// immutable record helpers, the cache-generation bump that invalidates in-flight
// loads, and the staleness rules that evict a PR's detail/diff/checks/threads
// caches when a list refresh shows its summary changed. Pure — no Zustand, no
// IPC; the store passes its state in (PullsState structurally satisfies
// `PrCacheSlice`).

import type { FileDiff, PrCheck, ReviewThread } from "../lib/api";
import type { PullRequest } from "../lib/prs";

/** The cache fields of `PullsState` these rules read/write — a structural
 * subset so this module never imports the store. */
export interface PrCacheSlice {
  pullRequests: PullRequest[];
  prDetails: Record<number, PullRequest>;
  prDetailLoading: boolean;
  prDetailLoadingByNum: Record<number, number>;
  prDetailError: Record<number, string>;
  prChecks: Record<number, PrCheck[]>;
  prChecksLoading: boolean;
  prChecksLoadingByNum: Record<number, number>;
  prChecksError: Record<number, string>;
  prDiffs: Record<number, FileDiff[]>;
  prDiffLoading: boolean;
  prDiffLoadingByNum: Record<number, number>;
  prDiffError: Record<number, string>;
  prThreads: Record<number, ReviewThread[]>;
  prThreadsLoading: boolean;
  prThreadsLoadingByNum: Record<number, number>;
  prThreadsError: Record<number, string>;
  prCommitsLoaded: Record<number, boolean>;
  prCommitsError: Record<number, string>;
  prResourceVersion: Record<number, number>;
}

// Drop one numeric key from a record without mutating it (used to clear a PR's
// per-resource error when its load is retried).
export function omit<V>(map: Record<number, V>, key: number): Record<number, V> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

export function hasNumericKeys(map: Record<number, unknown>): boolean {
  return Object.keys(map).length > 0;
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
        ...Object.keys(s.prDetails),
        ...Object.keys(s.prDiffs),
        ...Object.keys(s.prChecks),
        ...Object.keys(s.prThreads),
        ...Object.keys(s.prDetailLoadingByNum),
        ...Object.keys(s.prDiffLoadingByNum),
        ...Object.keys(s.prThreadsLoadingByNum),
        ...Object.keys(s.prChecksLoadingByNum),
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

// On a non-force list refresh, evict every per-PR cache (detail, diff, checks,
// threads, commit-sig markers, and their errors) for PRs that left the list or
// whose summary changed, so the prsFetchedAt-keyed tab effects refetch fresh
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
      ...Object.keys(s.prDetails),
      ...Object.keys(s.prDiffs),
      ...Object.keys(s.prChecks),
      ...Object.keys(s.prThreads),
      ...Object.keys(s.prDetailLoadingByNum),
      ...Object.keys(s.prDiffLoadingByNum),
      ...Object.keys(s.prThreadsLoadingByNum),
      ...Object.keys(s.prChecksLoadingByNum),
      ...s.pullRequests.map((p) => String(p.num)),
    ].map(Number),
  );
  const stale: number[] = [];
  for (const num of candidateNums) {
    const summary = byNum.get(num);
    if (!summary) {
      stale.push(num); // PR left the list
      continue;
    }
    // Baseline = the cached detail (richest) if loaded, else the previous list
    // summary; both carry the compared fields. Without either we can't tell.
    const baseline = s.prDetails[num] ?? prevByNum.get(num);
    if (baseline && !detailMatchesSummary(baseline, summary)) stale.push(num);
  }
  if (stale.length === 0) return {};
  const bumpedVersion = bumpResourceVersions(s.prResourceVersion, stale);
  // Evict the stale PRs' in-flight request slots so those requests drop on
  // settle (slot mismatch, GL-166) and — unlike waiting for the version guard —
  // the derived loading flags clear NOW instead of holding a spinner (or
  // masking another PR's error) until the stale network call returns.
  const detailLoadingByNum = omitMany(s.prDetailLoadingByNum, stale);
  const diffLoadingByNum = omitMany(s.prDiffLoadingByNum, stale);
  const threadsLoadingByNum = omitMany(s.prThreadsLoadingByNum, stale);
  const checksLoadingByNum = omitMany(s.prChecksLoadingByNum, stale);
  return {
    prDetails: omitMany(s.prDetails, stale),
    prDiffs: omitMany(s.prDiffs, stale),
    prChecks: omitMany(s.prChecks, stale),
    prThreads: omitMany(s.prThreads, stale),
    prCommitsLoaded: omitMany(s.prCommitsLoaded, stale),
    prCommitsError: omitMany(s.prCommitsError, stale),
    prDetailError: omitMany(s.prDetailError, stale),
    prDiffError: omitMany(s.prDiffError, stale),
    prChecksError: omitMany(s.prChecksError, stale),
    prThreadsError: omitMany(s.prThreadsError, stale),
    // Bump the cache generation so any in-flight signature load discards its
    // write (commits loads keep their slot in the module map — the version
    // covers them).
    prResourceVersion: bumpedVersion,
    prDetailLoadingByNum: detailLoadingByNum,
    prDetailLoading: hasNumericKeys(detailLoadingByNum),
    prDiffLoadingByNum: diffLoadingByNum,
    prDiffLoading: hasNumericKeys(diffLoadingByNum),
    prThreadsLoadingByNum: threadsLoadingByNum,
    prThreadsLoading: hasNumericKeys(threadsLoadingByNum),
    prChecksLoadingByNum: checksLoadingByNum,
    prChecksLoading: hasNumericKeys(checksLoadingByNum),
  };
}
