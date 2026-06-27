import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// IPC + the dialog/event plugins the hook touches on mount and during relocate.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const openDialogMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialogMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useOnboarding } from "./useOnboarding";
import { useRepo } from "../../store/repo";
import type { RecentRepo } from "../../store/repoSession";

const missing: RecentRepo = {
  path: "/old/gone",
  name: "gone",
  branch: null,
  lastOpenedAt: 0,
  missing: true,
};

beforeEach(() => {
  invokeMock.mockReset();
  // recents_status (mount refresh) and any other read resolve benignly.
  invokeMock.mockResolvedValue([]);
  openDialogMock.mockReset();
  localStorage.clear();
  useRepo.setState({ recents: [missing], summary: null });
});

afterEach(() => vi.restoreAllMocks());

describe("openRecent — relocating a missing recent", () => {
  it("keeps the stale entry and stays open when the picked folder is not a repo", async () => {
    openDialogMock.mockResolvedValue("/picked/not-a-repo");
    // loadRepo swallows a failed open: summary stays null (no repo opened).
    const loadSpy = vi.spyOn(useRepo.getState(), "loadRepo").mockResolvedValue(undefined);
    const removeSpy = vi.spyOn(useRepo.getState(), "removeRecent");
    const onDone = vi.fn();

    const { result } = renderHook(() => useOnboarding(onDone));
    act(() => result.current.openRecent(missing));

    await waitFor(() => expect(loadSpy).toHaveBeenCalledWith("/picked/not-a-repo"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(removeSpy).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(useRepo.getState().recents.map((r) => r.path)).toContain("/old/gone");
  });

  it("drops the stale entry and dismisses once a valid repo opens", async () => {
    openDialogMock.mockResolvedValue("/picked/real");
    const loadSpy = vi.spyOn(useRepo.getState(), "loadRepo").mockImplementation(async () => {
      useRepo.setState({
        summary: {
          path: "/picked/real",
          workdir: "/picked/real",
          headBranch: "main",
          headOid: null,
          detached: false,
        },
      });
    });
    const removeSpy = vi.spyOn(useRepo.getState(), "removeRecent");
    const onDone = vi.fn();

    const { result } = renderHook(() => useOnboarding(onDone));
    act(() => result.current.openRecent(missing));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(loadSpy).toHaveBeenCalledWith("/picked/real");
    expect(removeSpy).toHaveBeenCalledWith("/old/gone");
  });
});

describe("overlay unmount during clone", () => {
  it("cancels an in-flight clone when the hook unmounts mid-progress", async () => {
    useRepo.setState({
      recents: [{ path: "/code/x", name: "x", branch: null, lastOpenedAt: 0 }],
      summary: null,
    });
    // clone_repo stays in flight; other reads (recents_status, cancel_clone) resolve.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "clone_repo" ? new Promise<string>(() => {}) : Promise.resolve([]),
    );

    const { result, unmount } = renderHook(() => useOnboarding());
    act(() => result.current.setCloneUrl("https://github.com/o/r.git"));
    act(() => result.current.startClone());
    await waitFor(() => expect(result.current.screen).toBe("progress"));

    unmount();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("cancel_clone"));
  });
});
