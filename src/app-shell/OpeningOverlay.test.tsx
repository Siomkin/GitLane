// The delayed opening overlay (tab-open-progress): nothing before the delay,
// the repository's name (or the SSH phase) after it, gone when the open ends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRemoteSessions } from "@/store/remoteSessions";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { OPENING_OVERLAY_DELAY_MS, OpeningOverlay } from "./OpeningOverlay";

const pending = (path: string) => ({ path, tab: path });
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  useUi.setState({ repoGroups: [], repoLabelsByIdentity: {} });
  useRepo.setState({ pendingOpen: null, tabInfoByPath: {} });
  useRemoteSessions.setState({ byOrigin: {}, connections: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("OpeningOverlay", () => {
  it("waits out the delay before naming the repository", () => {
    render(<OpeningOverlay />);
    act(() => useRepo.setState({ pendingOpen: pending("/dev/backend") }));
    expect(screen.queryByRole("status")).toBeNull();
    advance(OPENING_OVERLAY_DELAY_MS - 1);
    expect(screen.queryByRole("status")).toBeNull();
    advance(1);
    expect(screen.getByRole("status")).toHaveTextContent("Opening backend…");
  });

  it("restarts the delay for a newer open and disappears when the open ends", () => {
    render(<OpeningOverlay />);
    act(() => useRepo.setState({ pendingOpen: pending("/dev/backend") }));
    advance(OPENING_OVERLAY_DELAY_MS);
    act(() => useRepo.setState({ pendingOpen: pending("/dev/frontend") }));
    expect(screen.queryByRole("status")).toBeNull();
    advance(OPENING_OVERLAY_DELAY_MS);
    expect(screen.getByRole("status")).toHaveTextContent("Opening frontend…");
    act(() => useRepo.setState({ pendingOpen: null }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("waits out the delay again when the same path reopens", () => {
    render(<OpeningOverlay />);
    act(() => useRepo.setState({ pendingOpen: pending("/dev/backend") }));
    advance(OPENING_OVERLAY_DELAY_MS);
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => useRepo.setState({ pendingOpen: null }));
    act(() => useRepo.setState({ pendingOpen: pending("/dev/backend") }));
    expect(screen.queryByRole("status")).toBeNull();
    advance(OPENING_OVERLAY_DELAY_MS);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("never shows for an open that ends inside the delay", () => {
    render(<OpeningOverlay />);
    act(() => useRepo.setState({ pendingOpen: pending("/dev/backend") }));
    advance(OPENING_OVERLAY_DELAY_MS / 2);
    act(() => useRepo.setState({ pendingOpen: null }));
    advance(OPENING_OVERLAY_DELAY_MS);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("cancels the pending open from its Cancel button", () => {
    const cancelPendingOpen = vi.fn();
    const real = useRepo.getState().cancelPendingOpen;
    useRepo.setState({ cancelPendingOpen });
    try {
      render(<OpeningOverlay />);
      act(() => useRepo.setState({ pendingOpen: pending("/dev/backend") }));
      advance(OPENING_OVERLAY_DELAY_MS);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(cancelPendingOpen).toHaveBeenCalledOnce();
    } finally {
      useRepo.setState({ cancelPendingOpen: real });
    }
  });

  it("names the host while a still-connected session waits", () => {
    useRemoteSessions.setState({ byOrigin: { "ssh://devbox": { state: "connected" } } });
    render(<OpeningOverlay />);
    act(() => useRepo.setState({ pendingOpen: pending("ssh://devbox/srv/api") }));
    advance(OPENING_OVERLAY_DELAY_MS);
    expect(screen.getByRole("status")).toHaveTextContent("Opening api on devbox…");
  });

  it("shows an SSH host's connect and install phases", () => {
    const remote = "ssh://devbox/srv/api";
    useRemoteSessions.setState({ byOrigin: { "ssh://devbox": { state: "connecting" } } });
    render(<OpeningOverlay />);
    act(() => useRepo.setState({ pendingOpen: pending(remote) }));
    advance(OPENING_OVERLAY_DELAY_MS);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to devbox…");
    act(() =>
      useRemoteSessions.setState({
        byOrigin: { "ssh://devbox": { state: "installing", progress: { stage: "uploading", percent: 62 } } },
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Installing GitLane agent — uploading 62%");
  });
});
