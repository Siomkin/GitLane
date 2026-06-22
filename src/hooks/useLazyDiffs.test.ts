import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FileDiff } from "../lib/api";
import { MAX_CONCURRENT_DIFFS, useLazyDiffs } from "./useLazyDiffs";

/** A fetch whose resolution we control, so concurrency is observable. */
function deferred() {
  let resolve!: (value: FileDiff) => void;
  const promise = new Promise<FileDiff>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
