import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// IPC + the dialog/event plugins the hook touches on mount and during relocate.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const openDialogMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialogMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useOnboarding } from "./useOnboarding";
import { useRepo } from "../../../store/repo";
import type { RecentRepo } from "../../../store/repoSession";

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
    // The shared Locate… flow probes the pick with the classified open; a
    // non-repo folder rejects, so nothing is opened, migrated, or dropped.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo"
        ? Promise.reject({
            kind: "notARepository",
            message: "The folder at /picked/not-a-repo is not a git repository anymore.",
            path: "/picked/not-a-repo",
          })
        : Promise.resolve([]),
    );
    const loadSpy = vi.spyOn(useRepo.getState(), "loadRepo");
    const onDone = vi.fn();

    const { result } = renderHook(() => useOnboarding(onDone));
    act(() => result.current.openRecent(missing));

    await waitFor(() => expect(openDialogMock).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    expect(loadSpy).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(useRepo.getState().recents.map((r) => r.path)).toContain("/old/gone");
  });

  it("drops the stale entry and dismisses once a valid repo opens", async () => {
    openDialogMock.mockResolvedValue("/picked/real");
    // The probe open resolves the normalized summary; the follow-up full load
    // is stubbed to publish it as the active repo.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo"
        ? Promise.resolve({
            path: "/picked/real",
            workdir: "/picked/real",
            headBranch: "main",
            headOid: null,
            detached: false,
          })
        : Promise.resolve([]),
    );
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
    const onDone = vi.fn();

    const { result } = renderHook(() => useOnboarding(onDone));
    act(() => result.current.openRecent(missing));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(loadSpy).toHaveBeenCalledWith("/picked/real");
    // The shared Locate… flow dropped the dead entry itself.
    expect(useRepo.getState().recents.map((r) => r.path)).not.toContain("/old/gone");
  });
});

describe("openRecent — opening a present recent", () => {
  const present: RecentRepo = { path: "/code/present", name: "present", branch: "main", lastOpenedAt: 0 };

  it("keeps the overlay open when the open fails (no path change)", async () => {
    useRepo.setState({ recents: [present], summary: null });
    // loadRepo fails to open → summary stays null (path unchanged).
    const loadSpy = vi.spyOn(useRepo.getState(), "loadRepo").mockResolvedValue(undefined);
    const onDone = vi.fn();

    const { result } = renderHook(() => useOnboarding(onDone));
    act(() => result.current.openRecent(present));

    await waitFor(() => expect(loadSpy).toHaveBeenCalledWith("/code/present"));
    await act(async () => {
      await Promise.resolve();
    });

    // No path change → not dismissed; the global error bar surfaces the failure.
    expect(onDone).not.toHaveBeenCalled();
  });

  it("dismisses once the repo becomes active", async () => {
    useRepo.setState({ recents: [present], summary: null });
    const loadSpy = vi.spyOn(useRepo.getState(), "loadRepo").mockImplementation(async () => {
      useRepo.setState({
        summary: {
          path: "/code/present",
          workdir: "/code/present",
          headBranch: "main",
          headOid: null,
          detached: false,
        },
      });
    });
    const onDone = vi.fn();

    const { result } = renderHook(() => useOnboarding(onDone));
    act(() => result.current.openRecent(present));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(loadSpy).toHaveBeenCalledWith("/code/present");
  });
});

describe("overlay unmount during clone", () => {
  it("saves clone tokens even when the HTTPS username is blank", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "approve_https_credential") return Promise.resolve({ username: "", helper: "store" });
      if (cmd === "clone_repo") return Promise.resolve("/tmp/repo");
      if (cmd === "open_repo") {
        return Promise.resolve({
          path: "/tmp/repo",
          workdir: "/tmp/repo",
          headBranch: "main",
          headOid: null,
          detached: false,
        });
      }
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useOnboarding());
    act(() => result.current.setCloneUrl("https://gitlab.com/group/repo.git"));
    act(() => result.current.setCloneUsername(""));
    act(() => result.current.setClonePassword("token"));
    act(() => result.current.startClone());

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("approve_https_credential", {
        credentialHost: "gitlab.com",
        path: "group/repo",
        username: "",
        password: "token",
      }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("clone_repo", {
        url: "https://gitlab.com/group/repo.git",
        dest: expect.any(String),
        auth: {
          mode: "credentialHelper",
          provider: "gitlab",
          host: "gitlab.com",
          credentialHost: "gitlab.com",
          username: null,
        },
      }),
    );
  });

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
