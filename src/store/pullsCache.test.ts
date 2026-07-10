// Per-PR cache maintenance rules (GL-161): reference-preserving record helpers,
// the cache-generation bump, and the staleness/eviction rules a list refresh
// applies. Pure — fixtures only, no store or IPC.
import { describe, expect, it } from "vitest";

import type { PullRequest } from "../lib/prs";
import {
  bumpResourceVersions,
  detailMatchesSummary,
  hasNumericKeys,
  knownPrNums,
  omit,
  omitMany,
  pruneStalePrCaches,
  type PrCacheSlice,
} from "./pullsCache";

const pr = (num: number, over: Partial<PullRequest> = {}): PullRequest =>
  ({
    num,
    state: "open",
    draft: false,
    title: `PR ${num}`,
    branch: `feat/${num}`,
    base: "latest",
    add: 1,
    del: 1,
    changedFiles: 1,
    mergeable: "",
    ...over,
  }) as PullRequest;

const slice = (over: Partial<PrCacheSlice> = {}): PrCacheSlice => ({
  pullRequests: [],
  prDetails: {},
  prDetailLoading: false,
  prDetailLoadingByNum: {},
  prDetailError: {},
  prChecks: {},
  prChecksLoading: false,
  prChecksLoadingByNum: {},
  prChecksError: {},
  prDiffs: {},
  prDiffLoading: false,
  prDiffLoadingByNum: {},
  prDiffError: {},
  prThreads: {},
  prThreadsLoading: false,
  prThreadsLoadingByNum: {},
  prThreadsError: {},
  prCommitsLoaded: {},
  prCommitsError: {},
  prResourceVersion: {},
  ...over,
});

describe("record helpers", () => {
  it("omit/omitMany drop keys immutably and keep the same reference when nothing drops", () => {
    const map = { 1: "a", 2: "b" };
    expect(omit(map, 3)).toBe(map);
    expect(omit(map, 1)).toEqual({ 2: "b" });
    expect(map).toEqual({ 1: "a", 2: "b" });
    expect(omitMany(map, [])).toBe(map);
    // Keys absent from the map also preserve the reference (GL-161 review) —
    // a stale PR with no entry in a given cache must not re-render its readers.
    expect(omitMany(map, [3, 4])).toBe(map);
    expect(omitMany(map, [1, 2])).toEqual({});
    expect(omitMany(map, [2, 3])).toEqual({ 1: "a" });
  });

  it("hasNumericKeys reports emptiness", () => {
    expect(hasNumericKeys({})).toBe(false);
    expect(hasNumericKeys({ 7: 1 })).toBe(true);
  });

  it("bumpResourceVersions increments per PR from 0 and keeps the reference on no-op", () => {
    const versions = { 1: 2 };
    expect(bumpResourceVersions(versions, [])).toBe(versions);
    expect(bumpResourceVersions(versions, [1, 2])).toEqual({ 1: 3, 2: 1 });
    expect(versions).toEqual({ 1: 2 });
  });
});

describe("knownPrNums", () => {
  it("unions every cache, in-flight token, version key, and the previous list, deduped", () => {
    const nums = knownPrNums(
      slice({
        pullRequests: [pr(1)],
        prDetails: { 1: pr(1), 2: pr(2) },
        prDiffs: { 3: [] },
        prChecks: { 4: [] },
        prThreads: { 5: [] },
        prChecksLoadingByNum: { 6: 9 },
        prResourceVersion: { 7: 1 },
        prDetailLoadingByNum: { 8: 10 },
        prDiffLoadingByNum: { 9: 11 },
        prThreadsLoadingByNum: { 10: 12 },
      }),
    );
    expect([...nums].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("detailMatchesSummary", () => {
  it("matches when all summary-level fields agree", () => {
    expect(detailMatchesSummary(pr(1), pr(1))).toBe(true);
  });

  it("flags any summary-level change", () => {
    for (const change of [
      { state: "merged" },
      { draft: true },
      { title: "renamed" },
      { base: "develop" },
      { branch: "other" },
      { add: 9 },
      { del: 9 },
      { changedFiles: 9 },
    ] as Partial<PullRequest>[]) {
      expect(detailMatchesSummary(pr(1), pr(1, change))).toBe(false);
    }
  });

  it("compares mergeability only on a definitive list verdict", () => {
    // "UNKNOWN"/"" from `gh pr list` must not invalidate every refresh.
    expect(detailMatchesSummary(pr(1, { mergeable: "MERGEABLE" }), pr(1, { mergeable: "UNKNOWN" }))).toBe(true);
    expect(detailMatchesSummary(pr(1, { mergeable: "MERGEABLE" }), pr(1, { mergeable: "" }))).toBe(true);
    expect(detailMatchesSummary(pr(1, { mergeable: "MERGEABLE" }), pr(1, { mergeable: "CONFLICTING" }))).toBe(false);
    expect(detailMatchesSummary(pr(1, { mergeable: "" }), pr(1, { mergeable: "MERGEABLE" }))).toBe(false);
  });
});

describe("pruneStalePrCaches", () => {
  it("returns an empty patch (preserving references) when nothing is stale", () => {
    const s = slice({ pullRequests: [pr(1)], prDetails: { 1: pr(1) } });
    expect(pruneStalePrCaches(s, [pr(1)])).toEqual({});
  });

  it("evicts every cache and bumps the version for a PR that left the list", () => {
    const s = slice({
      pullRequests: [pr(1), pr(2)],
      prDetails: { 1: pr(1) },
      prDiffs: { 1: [] },
      prChecks: { 1: [] },
      prThreads: { 1: [] },
      prCommitsLoaded: { 1: true },
      prCommitsError: { 1: "commits failed" },
      prDetailError: { 1: "e" },
      prResourceVersion: { 1: 1 },
    });
    const patch = pruneStalePrCaches(s, [pr(2)]);
    expect(patch.prDetails).toEqual({});
    expect(patch.prDiffs).toEqual({});
    expect(patch.prChecks).toEqual({});
    expect(patch.prThreads).toEqual({});
    expect(patch.prCommitsLoaded).toEqual({});
    // The commits error is evicted with the rest (GL-164) — a stale failure
    // must not linger after the PR left the list or changed.
    expect(patch.prCommitsError).toEqual({});
    expect(patch.prDetailError).toEqual({});
    expect(patch.prResourceVersion).toEqual({ 1: 2 });
  });

  it("evicts on a changed summary, using the previous list as baseline when no detail is cached", () => {
    // PR 1's first detail load is still in flight (no cache entry), but its
    // summary changed vs the previous list — the version must still bump so the
    // in-flight response is discarded.
    const s = slice({ pullRequests: [pr(1)], prCommitsError: { 1: "old failure" } });
    const patch = pruneStalePrCaches(s, [pr(1, { title: "force-pushed" })]);
    expect(patch.prResourceVersion).toEqual({ 1: 1 });
    // The summary-change path evicts the commits error too (GL-164) — not just
    // the left-the-list path the matrix test covers.
    expect(patch.prCommitsError).toEqual({});
    // Caches the stale PR has no entries in keep their references (GL-161
    // review), so unrelated subscribers don't re-render on the quiet refresh.
    expect(patch.prDetails).toBe(s.prDetails);
    expect(patch.prDiffs).toBe(s.prDiffs);
    expect(patch.prChecks).toBe(s.prChecks);
  });

  it("clears in-flight checks tokens for stale PRs and recomputes the global flag", () => {
    const s = slice({
      pullRequests: [pr(1), pr(2)],
      prChecksLoadingByNum: { 1: 11, 2: 22 },
      prChecksLoading: true,
    });
    const stalePatch = pruneStalePrCaches(s, [pr(2)]);
    expect(stalePatch.prChecksLoadingByNum).toEqual({ 2: 22 });
    expect(stalePatch.prChecksLoading).toBe(true);
    const allStale = pruneStalePrCaches(s, []);
    expect(allStale.prChecksLoadingByNum).toEqual({});
    expect(allStale.prChecksLoading).toBe(false);
  });

  it("clears in-flight detail/diff/threads slots for stale PRs and recomputes the global flags (GL-166)", () => {
    const s = slice({
      pullRequests: [pr(1), pr(2)],
      prDetailLoadingByNum: { 1: 11, 2: 22 },
      prDetailLoading: true,
      prDiffLoadingByNum: { 1: 33 },
      prDiffLoading: true,
      prThreadsLoadingByNum: { 1: 44 },
      prThreadsLoading: true,
    });
    // PR 1 leaves the list: its slots evict so the stale requests drop on settle
    // and the derived flags clear now — not when the stale network call returns.
    const stalePatch = pruneStalePrCaches(s, [pr(2)]);
    expect(stalePatch.prDetailLoadingByNum).toEqual({ 2: 22 });
    expect(stalePatch.prDetailLoading).toBe(true);
    expect(stalePatch.prDiffLoadingByNum).toEqual({});
    expect(stalePatch.prDiffLoading).toBe(false);
    expect(stalePatch.prThreadsLoadingByNum).toEqual({});
    expect(stalePatch.prThreadsLoading).toBe(false);
  });

  it("treats a PR with only an in-flight detail slot as a prune candidate", () => {
    // First detail load in flight, nothing cached yet, PR not in the previous
    // list — the slot alone must make it a candidate so leaving the refreshed
    // list still bumps its version and evicts the slot.
    const s = slice({
      prDetailLoadingByNum: { 5: 55 },
      prDetailLoading: true,
    });
    const patch = pruneStalePrCaches(s, []);
    expect(patch.prDetailLoadingByNum).toEqual({});
    expect(patch.prDetailLoading).toBe(false);
    expect(patch.prResourceVersion).toEqual({ 5: 1 });
  });
});
