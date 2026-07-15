import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FileDiff } from "@/lib/api";
import { MAX_CONCURRENT_DIFFS, useLazyDiffs } from "./useLazyDiffs";

/** A fetch whose settlement we control, so concurrency is observable. */
function deferred() {
  let resolve!: (value: FileDiff) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<FileDiff>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useLazyDiffs", () => {
  it("caps concurrent fetches and drains the queue as slots free", async () => {
    const total = MAX_CONCURRENT_DIFFS + 3;
    const defs = Array.from({ length: total }, () => deferred());
    const started: number[] = [];
    const items = defs.map((d, index) => ({
      key: `f${index}`,
      fetch: () => {
        started.push(index);
        return d.promise;
      },
    }));

    const { result } = renderHook(() => useLazyDiffs());
    act(() => result.current.ensure(items));

    // Only the window's worth start immediately; the rest queue in order.
    expect(started).toEqual(Array.from({ length: MAX_CONCURRENT_DIFFS }, (_, i) => i));

    // Each completion frees exactly one slot for the next queued item.
    await act(async () => {
      defs[0].resolve({} as FileDiff);
    });
    expect(started).toHaveLength(MAX_CONCURRENT_DIFFS + 1);
    expect(started).toContain(MAX_CONCURRENT_DIFFS);

    await act(async () => {
      defs.slice(1).forEach((d) => d.resolve({} as FileDiff));
    });
    await waitFor(() => expect(Object.keys(result.current.diffs)).toHaveLength(total));
    expect(started).toHaveLength(total);
  });

  it("de-duplicates keys already cached or in flight", async () => {
    const def = deferred();
    let calls = 0;
    const item = {
      key: "same",
      fetch: () => {
        calls += 1;
        return def.promise;
      },
    };

    const { result } = renderHook(() => useLazyDiffs());
    act(() => result.current.ensure([item, item])); // duplicate within one call
    act(() => result.current.ensure([item])); // already in flight
    expect(calls).toBe(1);

    await act(async () => {
      def.resolve({} as FileDiff);
    });
    act(() => result.current.ensure([item])); // now cached
    expect(calls).toBe(1);
  });

  it("evicts settled entries so a virtual surface can re-fetch them", async () => {
    let calls = 0;
    const item = {
      key: "far-away",
      fetch: () => {
        calls += 1;
        return Promise.resolve({ path: "far-away" } as FileDiff);
      },
    };
    const { result } = renderHook(() => useLazyDiffs());

    await act(async () => result.current.ensure([item]));
    expect(result.current.diffs).toHaveProperty("far-away");

    act(() => result.current.evict(["far-away"]));
    expect(result.current.diffs).not.toHaveProperty("far-away");

    await act(async () => result.current.ensure([item]));
    expect(calls).toBe(2);
    expect(result.current.diffs).toHaveProperty("far-away");
  });

  it("drops obsolete queued viewport work without cancelling active fetches", async () => {
    const activeDefs = Array.from({ length: MAX_CONCURRENT_DIFFS }, () => deferred());
    const staleDefs = Array.from({ length: 2 }, () => deferred());
    const currentDefs = Array.from({ length: 2 }, () => deferred());
    const started: string[] = [];
    const item = (key: string, d: ReturnType<typeof deferred>) => ({
      key,
      fetch: () => {
        started.push(key);
        return d.promise;
      },
    });
    const active = activeDefs.map((d, index) => item(`active${index}`, d));
    const stale = staleDefs.map((d, index) => item(`stale${index}`, d));
    const current = currentDefs.map((d, index) => item(`current${index}`, d));

    const { result } = renderHook(() => useLazyDiffs());
    act(() => result.current.ensure([...active, ...stale]));
    expect(started).toHaveLength(MAX_CONCURRENT_DIFFS);

    // The viewport jumps while the physical window is full. Pending work from
    // the old window is discarded; already-started work remains capacity-bound.
    act(() => {
      result.current.retainQueued(current.map(({ key }) => key));
      result.current.ensure(current);
    });
    await act(async () => {
      activeDefs[0].resolve({} as FileDiff);
    });
    expect(started[MAX_CONCURRENT_DIFFS]).toBe("current0");
    expect(started).not.toContain("stale0");
    expect(started).not.toContain("stale1");

    await act(async () => {
      activeDefs.slice(1).forEach((d) => d.resolve({} as FileDiff));
      currentDefs.forEach((d) => d.resolve({} as FileDiff));
    });
  });

  it("drops in-flight results after reset() so a new set isn't polluted", async () => {
    const def = deferred();
    const { result } = renderHook(() => useLazyDiffs());
    act(() => result.current.ensure([{ key: "old", fetch: () => def.promise }]));

    act(() => result.current.reset());
    await act(async () => {
      def.resolve({} as FileDiff);
    });

    expect(result.current.diffs).not.toHaveProperty("old");
  });

  // reset() invalidates publication, but the un-cancellable IPC promises keep
  // consuming backend workers — the physical fetch window must stay bounded by
  // MAX_CONCURRENT_DIFFS across resets, with new work starting only as old
  // work actually settles (GL-172).
  it("keeps the fetch window bounded across reset()", async () => {
    const oldDefs = Array.from({ length: MAX_CONCURRENT_DIFFS }, () => deferred());
    const newDefs = Array.from({ length: MAX_CONCURRENT_DIFFS }, () => deferred());
    const started: string[] = [];
    const item = (key: string, d: ReturnType<typeof deferred>) => ({
      key,
      fetch: () => {
        started.push(key);
        return d.promise;
      },
    });

    const { result } = renderHook(() => useLazyDiffs());
    act(() => result.current.ensure(oldDefs.map((d, i) => item(`old${i}`, d))));
    expect(started).toHaveLength(MAX_CONCURRENT_DIFFS); // window full of old work

    act(() => result.current.reset());
    act(() => result.current.ensure(newDefs.map((d, i) => item(`new${i}`, d))));

    // The old fetches are still physically running: no new fetch may start yet.
    expect(started).toHaveLength(MAX_CONCURRENT_DIFFS);

    // Each old settle frees exactly one slot for one new fetch.
    await act(async () => {
      oldDefs[0].resolve({} as FileDiff);
    });
    expect(started).toHaveLength(MAX_CONCURRENT_DIFFS + 1);
    expect(started[MAX_CONCURRENT_DIFFS]).toBe("new0");

    await act(async () => {
      oldDefs.slice(1).forEach((d) => d.resolve({} as FileDiff));
    });
    expect(started).toHaveLength(MAX_CONCURRENT_DIFFS * 2);

    await act(async () => {
      newDefs.forEach((d) => d.resolve({} as FileDiff));
    });
    await waitFor(() =>
      expect(Object.keys(result.current.diffs)).toHaveLength(MAX_CONCURRENT_DIFFS),
    );
    // Only the new generation published; the old results were dropped.
    expect(Object.keys(result.current.diffs).every((k) => k.startsWith("new"))).toBe(true);
  });

  it("frees slots when invalidated old fetches reject, across repeated resets", async () => {
    const a = Array.from({ length: MAX_CONCURRENT_DIFFS }, () => deferred());
    const b = Array.from({ length: MAX_CONCURRENT_DIFFS }, () => deferred());
    const c = Array.from({ length: MAX_CONCURRENT_DIFFS }, () => deferred());
    const started: string[] = [];
    const item = (key: string, d: ReturnType<typeof deferred>) => ({
      key,
      fetch: () => {
        started.push(key);
        return d.promise;
      },
    });

    const { result } = renderHook(() => useLazyDiffs());
    act(() => result.current.ensure(a.map((d, i) => item(`a${i}`, d))));
    act(() => result.current.reset());
    act(() => result.current.ensure(b.map((d, i) => item(`b${i}`, d))));
    act(() => result.current.reset());
    act(() => result.current.ensure(c.map((d, i) => item(`c${i}`, d))));

    // Two resets later the window is still the original six generation-a fetches.
    expect(started).toHaveLength(MAX_CONCURRENT_DIFFS);

    // Old work failing frees capacity exactly like success does — and only the
    // live generation's items start (generation b was dropped from the queue).
    await act(async () => {
      a.forEach((d) => d.reject(new Error("stale")));
    });
    expect(started).toHaveLength(MAX_CONCURRENT_DIFFS * 2);
    expect(started.slice(MAX_CONCURRENT_DIFFS).every((k) => k.startsWith("c"))).toBe(true);

    await act(async () => {
      c.forEach((d) => d.resolve({} as FileDiff));
    });
    await waitFor(() =>
      expect(Object.keys(result.current.diffs)).toHaveLength(MAX_CONCURRENT_DIFFS),
    );
    // Rejections from the stale generation never published failure entries.
    expect(Object.values(result.current.diffs).every((v) => v !== null)).toBe(true);
  });

  it("lets a same-commit ensure() after reset() refetch a cached key", async () => {
    // reset() must clear the cacheRef view synchronously, not just the state:
    // a caller that resets and re-ensures in the same commit (the changes
    // view's snapshot effect, GL-173) must not see the ghost of the dropped
    // cache and skip its refetch.
    let calls = 0;
    const item = () => ({
      key: "same",
      fetch: () => {
        calls += 1;
        return Promise.resolve({} as FileDiff);
      },
    });

    const { result } = renderHook(() => useLazyDiffs());
    await act(async () => result.current.ensure([item()]));
    expect(calls).toBe(1);

    act(() => {
      result.current.reset();
      result.current.ensure([item()]);
    });
    expect(calls).toBe(2);
  });

  it("recovers the slot when a fetcher throws synchronously", async () => {
    const defs = Array.from({ length: MAX_CONCURRENT_DIFFS }, () => deferred());
    const started: string[] = [];

    const { result } = renderHook(() => useLazyDiffs());
    act(() =>
      result.current.ensure([
        {
          key: "boom",
          fetch: () => {
            throw new Error("sync throw");
          },
        },
      ]),
    );

    // Recorded as a failed fetch, not a stuck pending one…
    expect(result.current.diffs).toHaveProperty("boom", null);

    // …and the slot was returned: a full window of real fetches still starts.
    act(() =>
      result.current.ensure(
        defs.map((d, i) => ({
          key: `f${i}`,
          fetch: () => {
            started.push(`f${i}`);
            return d.promise;
          },
        })),
      ),
    );
    expect(started).toHaveLength(MAX_CONCURRENT_DIFFS);
  });

  it("drops queued (not yet started) items on reset without touching active capacity", async () => {
    const total = MAX_CONCURRENT_DIFFS + 2;
    const oldDefs = Array.from({ length: total }, () => deferred());
    const started: string[] = [];
    const item = (key: string, d: ReturnType<typeof deferred>) => ({
      key,
      fetch: () => {
        started.push(key);
        return d.promise;
      },
    });

    const { result } = renderHook(() => useLazyDiffs());
    act(() => result.current.ensure(oldDefs.map((d, i) => item(`old${i}`, d))));
    expect(started).toHaveLength(MAX_CONCURRENT_DIFFS); // 2 remain queued

    act(() => result.current.reset());
    await act(async () => {
      oldDefs.slice(0, MAX_CONCURRENT_DIFFS).forEach((d) => d.resolve({} as FileDiff));
    });

    // The two queued old-generation items were dropped by reset, not started.
    expect(started).toHaveLength(MAX_CONCURRENT_DIFFS);
    expect(started).not.toContain(`old${MAX_CONCURRENT_DIFFS}`);
  });

  it("doesn't let an old request clear a newer in-flight marker for the same key", async () => {
    const old = deferred();
    const next = deferred();
    const { result } = renderHook(() => useLazyDiffs());
    let nextCalls = 0;

    act(() => result.current.ensure([{ key: "same", fetch: () => old.promise }]));
    act(() => result.current.reset());
    act(() =>
      result.current.ensure([
        {
          key: "same",
          fetch: () => {
            nextCalls += 1;
            return next.promise;
          },
        },
      ]),
    );
    expect(nextCalls).toBe(1);

    await act(async () => {
      old.resolve({} as FileDiff);
    });

    act(() =>
      result.current.ensure([
        {
          key: "same",
          fetch: () => {
            nextCalls += 1;
            return next.promise;
          },
        },
      ]),
    );

    expect(nextCalls).toBe(1);
  });
});
