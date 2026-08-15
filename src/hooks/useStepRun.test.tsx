import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useStepRun } from "./useStepRun";

describe("useStepRun", () => {
  it("re-arms `mounted` across StrictMode's dev double-mount", () => {
    // StrictMode mounts → cleans up → remounts: a cleanup-only effect would
    // leave `mounted` permanently false on the live instance.
    const { result } = renderHook(() => useStepRun(), { wrapper: StrictMode });
    expect(result.current.mounted.current).toBe(true);

    // A real unmount still flips it, so late runs can guard their setState.
    const { result: plain, unmount } = renderHook(() => useStepRun());
    expect(plain.current.mounted.current).toBe(true);
    unmount();
    expect(plain.current.mounted.current).toBe(false);
  });

  it("a second start() during flight is a no-op", async () => {
    let release!: () => void;
    const body = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(() => useStepRun());

    let first = false;
    act(() => {
      first = result.current.start(body);
    });
    expect(first).toBe(true);
    expect(body).toHaveBeenCalledTimes(1);

    // The fast double-click: `phase` is stale render state, so the latch must
    // drop the second start synchronously.
    let second = false;
    act(() => {
      second = result.current.start(body);
    });
    expect(second).toBe(false);
    expect(body).toHaveBeenCalledTimes(1);

    // Once the run settles, the latch releases and a new run can start.
    await act(async () => {
      release();
    });
    let third = false;
    act(() => {
      third = result.current.start(body);
    });
    expect(third).toBe(true);
    await act(async () => {
      release();
    });
  });

  it("subscribes before the body and unlistens in the finally", async () => {
    const order: string[] = [];
    const unlisten = vi.fn(() => order.push("unlisten"));
    const subscribe = vi.fn(async () => {
      order.push("subscribe");
      return unlisten;
    });
    let release!: () => void;
    const body = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          order.push("body");
          release = resolve;
        }),
    );
    const { result } = renderHook(() => useStepRun());

    act(() => {
      result.current.start(body, subscribe);
    });
    // The scaffold awaits `subscribe` before the body, so flush the microtask
    // queue first — only then has the body run and captured `release`.
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      release();
    });
    // The earliest progress event can't be missed: subscribe resolves before
    // the body runs, and the unlisten fires exactly once on exit.
    expect(order).toEqual(["subscribe", "body", "unlisten"]);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("releases the latch and unlistens even when the body rejects", async () => {
    const unlisten = vi.fn();
    const body = vi.fn(async () => {
      throw new Error("boom");
    });
    const { result } = renderHook(() => useStepRun());

    let started = false;
    act(() => {
      started = result.current.start(body, async () => unlisten);
    });
    expect(started).toBe(true);
    // Let the rejected run settle through the scaffold's catch/finally.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(unlisten).toHaveBeenCalledTimes(1);

    // The latch is free again after a failed run — the next start() goes.
    let restarted = false;
    act(() => {
      restarted = result.current.start(vi.fn(async () => {}));
    });
    expect(restarted).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
  });
});
