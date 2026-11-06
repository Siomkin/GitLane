// revalidate(): the soft reset the changes view uses per working-tree snapshot.
// Values stay visible until their refetch lands; fetching and the generation
// guard behave exactly like reset() (GL-173).
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FileDiff } from "@/lib/api";
import { useLazyDiffs } from "./useLazyDiffs";

const diff = (tag: string) => ({ path: tag }) as unknown as FileDiff;

function deferred() {
  let resolve!: (value: FileDiff) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<FileDiff>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function loaded(tag: string) {
  const hook = renderHook(() => useLazyDiffs());
  act(() => hook.result.current.ensure([{ key: "a", fetch: () => Promise.resolve(diff(tag)) }]));
  await waitFor(() => expect(hook.result.current.diffs.a).toEqual(diff(tag)));
  return hook;
}

describe("useLazyDiffs revalidate()", () => {
  it("keeps the old value visible until the refetch replaces it", async () => {
    const { result } = await loaded("old");
    const next = deferred();

    act(() => result.current.revalidate());
    expect(result.current.diffs.a).toEqual(diff("old"));

    act(() => result.current.ensure([{ key: "a", fetch: () => next.promise }]));
    expect(result.current.diffs.a).toEqual(diff("old"));

    await act(async () => next.resolve(diff("new")));
    expect(result.current.diffs.a).toEqual(diff("new"));
  });

  it("refetches a stale key, then serves it from cache again", async () => {
    const { result } = await loaded("old");
    const fetch = vi.fn(() => Promise.resolve(diff("new")));

    act(() => result.current.revalidate());
    act(() => result.current.ensure([{ key: "a", fetch }]));
    await waitFor(() => expect(result.current.diffs.a).toEqual(diff("new")));

    act(() => result.current.ensure([{ key: "a", fetch }]));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("drops a result started before revalidate()", async () => {
    const { result } = await loaded("old");
    const late = deferred();
    act(() => result.current.evict(["a"]));
    act(() => result.current.ensure([{ key: "a", fetch: () => late.promise }]));

    act(() => result.current.revalidate());
    await act(async () => late.resolve(diff("late")));

    expect(result.current.diffs.a).toBeUndefined();
  });

  it("replaces the stale value with null when the refetch fails", async () => {
    const { result } = await loaded("old");

    act(() => result.current.revalidate());
    act(() => result.current.ensure([{ key: "a", fetch: () => Promise.reject(new Error("x")) }]));

    await waitFor(() => expect(result.current.diffs.a).toBeNull());
  });

  it("leaves reset() as a hard clear", async () => {
    const { result } = await loaded("old");
    act(() => result.current.revalidate());
    act(() => result.current.reset());
    expect(result.current.diffs).toEqual({});
  });
});
