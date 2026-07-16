import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useAutoFetch } from "./useAutoFetch";

const realShowToast = useUi.getState().showToast;

beforeEach(() => {
  vi.useFakeTimers();
  useUi.setState({ autoFetchEnabled: false, autoFetchMinutes: 15, showToast: realShowToast });
  useRepo.setState({
    summary: { path: "/repo", workdir: "/repo", headBranch: "main", headOid: "abc", detached: false },
    remotes: [{ name: "origin", fetchUrl: "https://example.test/repo.git", pushUrl: "https://example.test/repo.git", isDefault: true }],
    loading: false,
    netOps: 0,
    fetchingPath: null,
    fetch: vi.fn(async () => true),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAutoFetch", () => {
  it("fetches quietly at the configured interval", async () => {
    useUi.setState({ autoFetchEnabled: true, autoFetchMinutes: 5 });
    renderHook(() => useAutoFetch());

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(useRepo.getState().fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(useRepo.getState().fetch).toHaveBeenCalledWith({ quiet: true });
  });

  it("does not schedule when disabled and skips a busy repository", async () => {
    const fetch = useRepo.getState().fetch;
    const { rerender } = renderHook(() => useAutoFetch());
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetch).not.toHaveBeenCalled();

    useUi.setState({ autoFetchEnabled: true, autoFetchMinutes: 5 });
    useRepo.setState({ loading: true });
    rerender();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reschedules on an interval change and cancels when disabled again", async () => {
    const fetch = useRepo.getState().fetch;
    useUi.setState({ autoFetchEnabled: true, autoFetchMinutes: 5 });
    renderHook(() => useAutoFetch());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    act(() => useUi.setState({ autoFetchMinutes: 15 }));
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);

    act(() => useUi.setState({ autoFetchEnabled: false }));
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops ticking when the repository closes", async () => {
    const fetch = useRepo.getState().fetch;
    useUi.setState({ autoFetchEnabled: true, autoFetchMinutes: 5 });
    renderHook(() => useAutoFetch());

    act(() => useRepo.setState({ summary: null }));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips ticks while the window is hidden or a network op is in flight", async () => {
    const fetch = useRepo.getState().fetch;
    useUi.setState({ autoFetchEnabled: true, autoFetchMinutes: 5 });
    renderHook(() => useAutoFetch());

    const visibility = vi
      .spyOn(Document.prototype, "visibilityState", "get")
      .mockReturnValue("hidden");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetch).not.toHaveBeenCalled();
    visibility.mockRestore();

    useRepo.setState({ netOps: 1 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetch).not.toHaveBeenCalled();

    useRepo.setState({ netOps: 0 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stays off for a malformed persisted enable flag", async () => {
    const fetch = useRepo.getState().fetch;
    // Rehydrated storage can hold any JSON; a truthy non-boolean must not
    // silently enable background networking.
    useUi.setState({ autoFetchEnabled: "true" as never, autoFetchMinutes: 5 });
    renderHook(() => useAutoFetch());
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a completion landing after teardown neither counts nor toasts", async () => {
    const showToast = vi.fn();
    let resolveFetch!: (ok: boolean) => void;
    let call = 0;
    const fetch = vi.fn((): Promise<boolean> => {
      call += 1;
      if (call < 3) return Promise.resolve(false);
      return new Promise<boolean>((res) => (resolveFetch = res));
    });
    useUi.setState({ autoFetchEnabled: true, autoFetchMinutes: 5, showToast });
    useRepo.setState({ fetch });
    renderHook(() => useAutoFetch());

    // Two quick failures, then a third tick whose fetch is still on the wire.
    await vi.advanceTimersByTimeAsync(3 * 5 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(showToast).not.toHaveBeenCalled();

    // The user disables auto-fetch while that fetch is in flight; its late
    // failure must not fire the pause toast for a schedule that's gone.
    act(() => useUi.setState({ autoFetchEnabled: false }));
    resolveFetch(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("falls back to the default cadence for an invalid persisted value", async () => {
    const fetch = useRepo.getState().fetch;
    // e.g. the pre-toggle 0 sentinel surviving in localStorage.
    useUi.setState({ autoFetchEnabled: true, autoFetchMinutes: 0 as never });
    renderHook(() => useAutoFetch());

    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledWith({ quiet: true });
  });

  it("pauses the schedule after three consecutive failures and says so once", async () => {
    const showToast = vi.fn();
    const fetch = vi.fn(async () => false);
    useUi.setState({ autoFetchEnabled: true, autoFetchMinutes: 5, showToast });
    useRepo.setState({ fetch });
    renderHook(() => useAutoFetch());

    await vi.advanceTimersByTimeAsync(3 * 5 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(
      "Automatic fetch paused after repeated failures",
      "error",
    );

    // Paused: further ticks never fire until the repo or interval changes.
    await vi.advanceTimersByTimeAsync(6 * 5 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("treats a rejected fetch promise as a failure for the backoff", async () => {
    const showToast = vi.fn();
    const fetch = vi.fn(async () => {
      throw new Error("boom");
    });
    useUi.setState({ autoFetchEnabled: true, autoFetchMinutes: 5, showToast });
    useRepo.setState({ fetch });
    renderHook(() => useAutoFetch());

    await vi.advanceTimersByTimeAsync(3 * 5 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(showToast).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 5 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("resets the failure count on a success", async () => {
    const results = [false, false, true, false, false, false];
    let call = 0;
    const fetch = vi.fn(async () => results[call++] ?? true);
    const showToast = vi.fn();
    useUi.setState({ autoFetchEnabled: true, autoFetchMinutes: 5, showToast });
    useRepo.setState({ fetch });
    renderHook(() => useAutoFetch());

    // fail, fail, success, fail, fail, fail → pauses only at the 6th tick.
    await vi.advanceTimersByTimeAsync(6 * 5 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(6 * 5 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(6);
  });
});
