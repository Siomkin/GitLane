// Per-PR cache maintenance rules (GL-161): reference-preserving record helpers,
// the cache-generation bump, and the staleness/eviction rules a list refresh
// applies. Pure — fixtures only, no store or IPC. The resource record and its
// helpers live in `pullsResource` (GL-364); they are exercised here through the
// cache policy that consumes them.
import { describe, expect, it } from "vitest";

import type { PrDetail, PrSummary } from "@/lib/prs";
import {
  bumpResourceVersions,
  detailMatchesSummary,
  knownPrNums,
  pruneStalePrCaches,
  type PrCacheSlice,
} from "./pullsCache";
import {
  clearPrResources,
  emptyPrResources,
  omit,
  omitMany,
  patchPrResource,
  type PrResources,
  type PrResourceKind,
  type PrResourceState,
} from "./pullsResource";

/** Fixture usable as either shape: a full `PrDetail` (so it can seed the detail
 * cache, which now demands one) is assignable to `PrSummary` for list seeds. */
const pr = (num: number, over: Partial<PrDetail> = {}): PrDetail =>
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
    files: [],
    comments: 0,
    body: "",
    commentList: [],
    reviewers: [],
    assignees: [],
    labels: [],
    milestone: null,
    commits: [],
    participants: [],
    ...over,
  }) as PrDetail;

/** Build a resource record with per-kind overrides on an empty base. */
const resources = (patches: {
  [K in PrResourceKind]?: Partial<PrResourceState<K>>;
}): PrResources => {
  let next = emptyPrResources();
  for (const [kind, patch] of Object.entries(patches)) {
    next = patchPrResource(next, kind as PrResourceKind, patch as Partial<PrResourceState>);
  }
  return next;
};

const slice = (over: Partial<PrCacheSlice> = {}): PrCacheSlice => ({
  pullRequests: [],
  prStacks: {},
  prResources: emptyPrResources(),
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

  it("bumpResourceVersions increments per PR from 0 and keeps the reference on no-op", () => {
    const versions = { 1: 2 };
    expect(bumpResourceVersions(versions, [])).toBe(versions);
    expect(bumpResourceVersions(versions, [1, 2])).toEqual({ 1: 3, 2: 1 });
    expect(versions).toEqual({ 1: 2 });
  });
});

describe("knownPrNums", () => {
  it("unions every cache, in-flight slot, version key, and the previous list, deduped", () => {
    const nums = knownPrNums(
      slice({
        pullRequests: [pr(1)],
        prResources: resources({
          detail: { data: { 1: pr(1), 2: pr(2) }, slots: { 8: 10 } },
          diff: { data: { 3: [] }, slots: { 9: 11 } },
          checks: { data: { 4: [] }, slots: { 6: 9 } },
          threads: { data: { 5: { threads: [], truncated: false } }, slots: { 10: 12 } },
        }),
        prResourceVersion: { 7: 1 },
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
    ] as Partial<PrSummary>[]) {
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
    const s = slice({
      pullRequests: [pr(1)],
      prResources: resources({ detail: { data: { 1: pr(1) } } }),
    });
    expect(pruneStalePrCaches(s, [pr(1)])).toEqual({});
  });

  it("evicts every resource and bumps the version for a PR that left the list", () => {
    const s = slice({
      pullRequests: [pr(1), pr(2)],
      prResources: resources({
        detail: { data: { 1: pr(1) }, errors: { 1: "e" } },
        diff: { data: { 1: [] } },
        checks: { data: { 1: [] } },
        threads: { data: { 1: { threads: [], truncated: false } } },
        commits: { data: { 1: { truncated: false } }, errors: { 1: "commits failed" } },
      }),
      prResourceVersion: { 1: 1 },
    });
    const patch = pruneStalePrCaches(s, [pr(2)]);
    expect(patch.prResources?.detail.data).toEqual({});
    expect(patch.prResources?.diff.data).toEqual({});
    expect(patch.prResources?.checks.data).toEqual({});
    expect(patch.prResources?.threads.data).toEqual({});
    expect(patch.prResources?.commits.data).toEqual({});
    // The commits error is evicted with the rest (GL-164) — a stale failure
    // must not linger after the PR left the list or changed.
    expect(patch.prResources?.commits.errors).toEqual({});
    expect(patch.prResources?.detail.errors).toEqual({});
    expect(patch.prResourceVersion).toEqual({ 1: 2 });
  });

  it("evicts on a changed summary, using the previous list as baseline when no detail is cached", () => {
    // PR 1's first detail load is still in flight (no cache entry), but its
    // summary changed vs the previous list — the version must still bump so the
    // in-flight response is discarded.
    const s = slice({
      pullRequests: [pr(1)],
      prResources: resources({ commits: { errors: { 1: "old failure" } } }),
    });
    const patch = pruneStalePrCaches(s, [pr(1, { title: "force-pushed" })]);
    expect(patch.prResourceVersion).toEqual({ 1: 1 });
    // The summary-change path evicts the commits error too (GL-164) — not just
    // the left-the-list path the matrix test covers.
    expect(patch.prResources?.commits.errors).toEqual({});
    // Resources the stale PR has no entries in keep their references (GL-161
    // review), so unrelated subscribers don't re-render on the quiet refresh.
    expect(patch.prResources?.detail).toBe(s.prResources.detail);
    expect(patch.prResources?.diff).toBe(s.prResources.diff);
    expect(patch.prResources?.checks).toBe(s.prResources.checks);
    expect(patch.prResources?.threads).toBe(s.prResources.threads);
  });

  it("clears in-flight slots for stale PRs so their spinners drop now (GL-166)", () => {
    const s = slice({
      pullRequests: [pr(1), pr(2)],
      prResources: resources({
        checks: { slots: { 1: 11, 2: 22 } },
        detail: { slots: { 1: 33, 2: 44 } },
        diff: { slots: { 1: 55 } },
        threads: { slots: { 1: 66 } },
      }),
    });
    // PR 1 leaves the list: its slots evict so the stale requests drop on
    // settle — not when the stale network call returns.
    const stalePatch = pruneStalePrCaches(s, [pr(2)]);
    expect(stalePatch.prResources?.checks.slots).toEqual({ 2: 22 });
    expect(stalePatch.prResources?.detail.slots).toEqual({ 2: 44 });
    expect(stalePatch.prResources?.diff.slots).toEqual({});
    expect(stalePatch.prResources?.threads.slots).toEqual({});
  });

  it("keeps in-flight commits slots — the version bump is what covers them (GL-164)", () => {
    // Two commits loads may overlap in one generation, and only the newest may
    // publish — so eviction must not release the newest load's slot.
    const s = slice({
      pullRequests: [pr(1)],
      prResources: resources({ commits: { slots: { 1: 77 } } }),
    });
    const patch = pruneStalePrCaches(s, []);
    expect(patch.prResources?.commits.slots).toEqual({ 1: 77 });
    expect(patch.prResourceVersion).toEqual({ 1: 1 });
  });

  it("treats a PR with only an in-flight detail slot as a prune candidate", () => {
    // First detail load in flight, nothing cached yet, PR not in the previous
    // list — the slot alone must make it a candidate so leaving the refreshed
    // list still bumps its version and evicts the slot.
    const s = slice({ prResources: resources({ detail: { slots: { 5: 55 } } }) });
    const patch = pruneStalePrCaches(s, []);
    expect(patch.prResources?.detail.slots).toEqual({});
    expect(patch.prResourceVersion).toEqual({ 5: 1 });
  });
});

describe("clearPrResources", () => {
  it("empties every resource but keeps in-flight commits slots (GL-164)", () => {
    const r = resources({
      detail: { data: { 1: pr(1) }, slots: { 1: 11 }, errors: { 1: "e" } },
      checks: { slots: { 1: 22 } },
      commits: { data: { 1: { truncated: true } }, slots: { 1: 33 }, errors: { 1: "boom" } },
    });
    const cleared = clearPrResources(r);
    expect(cleared.detail).toEqual({ data: {}, slots: {}, errors: {} });
    expect(cleared.checks.slots).toEqual({});
    // Commits: cache and error clear like everyone else…
    expect(cleared.commits.data).toEqual({});
    expect(cleared.commits.errors).toEqual({});
    // …but the in-flight slot survives — the version bump the force path pairs
    // with this clear is what discards the request's write, not slot loss.
    expect(cleared.commits.slots).toBe(r.commits.slots);
  });
});
