import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const win = vi.hoisted(() => ({ onCloseRequested: vi.fn(), destroy: vi.fn() }));
const emit = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@tauri-apps/api/event", () => ({ emit, listen: vi.fn() }));
vi.mock("@/lib/platform", async (load) => ({
  ...(await load<typeof import("@/lib/platform")>()),
  isTauri: true,
}));

import { useRepo } from "@/store/repo";
import type { FileViewState } from "@/store/repoTypes";
import { useUi } from "@/store/ui";
import { useCloseGuard } from "./useCloseGuard";

const file = (draft: string) =>
  ({
    path: "a.ts",
    content: { text: "saved" },
    loading: false,
    error: null,
    edit: { draft, baseSize: 5, baseExpectedState: "s", saving: false },
  }) as unknown as FileViewState;

const realGuard = useRepo.getState().guardDirtyFileView;

const requestClose = () => {
  renderHook(() => useCloseGuard());
  const handler = win.onCloseRequested.mock.calls[0][0] as (event: {
    preventDefault: () => void;
  }) => void;
  const event = { preventDefault: vi.fn() };
  handler(event);
  return event;
};

beforeEach(() => {
  win.onCloseRequested.mockReset();
  win.onCloseRequested.mockResolvedValue(() => {});
  win.destroy.mockReset();
  win.destroy.mockResolvedValue(undefined);
  emit.mockReset();
  emit.mockResolvedValue(undefined);
  useRepo.setState({ fileView: null, guardDirtyFileView: realGuard });
  useUi.setState({ confirm: null });
});

describe("useCloseGuard", () => {
  it("keeps the window open and asks when the draft is dirty", () => {
    useRepo.setState({ fileView: file("typed") });
    const event = requestClose();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(useUi.getState().confirm?.title).toBe("Discard unsaved changes?");
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it("destroys the window once the discard is confirmed", () => {
    useRepo.setState({ fileView: file("typed") });
    requestClose();
    useUi.getState().confirm?.onConfirm();
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });

  it("leaves a clean close to Tauri", () => {
    useRepo.setState({ fileView: file("saved") });
    const event = requestClose();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(useUi.getState().confirm).toBeNull();
  });

  it("tells the Quit item the webview answered", () => {
    requestClose();
    expect(emit).toHaveBeenCalledWith("close-request-seen");
  });

  it("offers a way out while a save is still running", () => {
    useRepo.setState({
      fileView: { ...file("typed"), edit: { ...file("typed").edit!, saving: true } },
    });
    const event = requestClose();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(useUi.getState().confirm?.confirmLabel).toBe("Close anyway");
    useUi.getState().confirm?.onConfirm();
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });

  it("logs a listener that could not be installed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    win.onCloseRequested.mockRejectedValue(new Error("denied"));
    renderHook(() => useCloseGuard());
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith("close guard not installed", expect.any(Error)),
    );
    error.mockRestore();
  });

  it("allows the close if the guard throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useRepo.setState({
      fileView: file("typed"),
      guardDirtyFileView: () => {
        throw new Error("broken");
      },
    });
    const event = requestClose();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
