import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextMenu } from "@/store/ui";
import { useBranchFastForwardProbe } from "./useBranchFastForwardProbe";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const menu = (): ContextMenu => ({ x: 10, y: 10, branch: "feature", isCurrent: false });

const baseProps = (owner: ContextMenu | null) => ({
  owner,
  repoPath: "/work/repo" as string | null,
  targetOid: "feature-oid" as string | null,
  currentOid: "main-oid" as string | null,
  enabled: true,
  unrelated: 0,
});

beforeEach(() => {
  invokeMock.mockReset();
});

describe("useBranchFastForwardProbe", () => {
  it("does not reprobe for an unrelated rerender", async () => {
    invokeMock.mockResolvedValue(true);
    const owner = menu();
    const { result, rerender } = renderHook(
      ({ unrelated: _unrelated, ...props }) => useBranchFastForwardProbe(props),
      { initialProps: baseProps(owner) },
    );

    await waitFor(() => expect(result.current).toBe(true));
    rerender({ ...baseProps(owner), unrelated: 1 });

    expect(result.current).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("reprobes close/reopen of the same branch and rejects the first opening's answer", async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    invokeMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const firstOwner = menu();
    const { result, rerender } = renderHook(
      ({ unrelated: _unrelated, ...props }) => useBranchFastForwardProbe(props),
      { initialProps: baseProps(firstOwner) },
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    rerender(baseProps(null));
    const secondOwner = menu();
    rerender(baseProps(secondOwner));
    expect(invokeMock).toHaveBeenCalledTimes(2);

    await act(async () => first.resolve(true));
    expect(result.current).toBe(false);

    await act(async () => second.resolve(true));
    expect(result.current).toBe(true);
  });

  it("does not flash a prior true result after reopening the same branch", async () => {
    const second = deferred<boolean>();
    invokeMock.mockResolvedValueOnce(true).mockReturnValueOnce(second.promise);
    const firstOwner = menu();
    const { result, rerender } = renderHook(
      ({ unrelated: _unrelated, ...props }) => useBranchFastForwardProbe(props),
      { initialProps: baseProps(firstOwner) },
    );

    await waitFor(() => expect(result.current).toBe(true));
    rerender(baseProps(null));
    rerender(baseProps(menu()));

    expect(result.current).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve(true));
    expect(result.current).toBe(true);
  });

  it("fails closed immediately and reprobes when the repository and oids switch", async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    invokeMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const owner = menu();
    const { result, rerender } = renderHook(
      ({ unrelated: _unrelated, ...props }) => useBranchFastForwardProbe(props),
      { initialProps: baseProps(owner) },
    );

    await act(async () => first.resolve(true));
    expect(result.current).toBe(true);

    rerender({
      ...baseProps(owner),
      repoPath: "/work/other",
      targetOid: "other-feature-oid",
      currentOid: "other-main-oid",
    });
    expect(result.current).toBe(false);
    expect(invokeMock).toHaveBeenLastCalledWith("can_fast_forward", {
      path: "/work/other",
      from: "other-feature-oid",
      to: "other-main-oid",
    });

    await act(async () => second.resolve(true));
    expect(result.current).toBe(true);
  });

  it("ignores a delayed answer from an older oid tuple", async () => {
    const stale = deferred<boolean>();
    const current = deferred<boolean>();
    invokeMock.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const owner = menu();
    const { result, rerender } = renderHook(
      ({ unrelated: _unrelated, ...props }) => useBranchFastForwardProbe(props),
      { initialProps: baseProps(owner) },
    );

    rerender({ ...baseProps(owner), targetOid: "new-feature-oid" });
    await act(async () => current.resolve(true));
    expect(result.current).toBe(true);

    await act(async () => stale.resolve(false));
    expect(result.current).toBe(true);
  });
});
