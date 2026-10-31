import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
const unlisten = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return Promise.resolve(unlisten);
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { REMOTE_SESSION_CHANGED, SSH_PROMPT } from "@/lib/api";
import { useRemoteSessions } from "@/store/remoteSessions";
import { useRepo } from "@/store/repo";
import { useRemoteSessionEvents } from "./useRemoteSessionEvents";

const summary = (path: string) => ({
  path,
  workdir: path,
  headBranch: "main",
  headOid: null,
  detached: false,
  unborn: false,
  isWorktree: false,
});

const emit = (payload: unknown) => handlers.get(REMOTE_SESSION_CHANGED)?.({ payload });

beforeEach(() => {
  handlers.clear();
  unlisten.mockReset();
  useRemoteSessions.setState({ byOrigin: {}, prompts: [] });
});

describe("useRemoteSessionEvents", () => {
  it("queues the questions ssh asks while connecting", () => {
    renderHook(() => useRemoteSessionEvents());
    const prompt = { id: 4, origin: "ssh://devbox", prompt: "password: ", kind: "secret" };
    handlers.get(SSH_PROMPT)?.({ payload: prompt });
    expect(useRemoteSessions.getState().prompts).toEqual([prompt]);
  });

  it("records each host's session state", () => {
    renderHook(() => useRemoteSessionEvents());
    emit({ origin: "ssh://devbox", state: "installing", progress: { stage: "downloading", percent: 10 } });
    expect(useRemoteSessions.getState().byOrigin["ssh://devbox"]).toEqual({
      state: "installing",
      progress: { stage: "downloading", percent: 10 },
    });
  });

  it("refreshes the active tab when its host drops, and only then", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ summary: summary("ssh://devbox/srv/app"), refresh });
    renderHook(() => useRemoteSessionEvents());

    emit({ origin: "ssh://other", state: "disconnected" });
    emit({ origin: "ssh://devbox", state: "connected" });
    expect(refresh).not.toHaveBeenCalled();

    emit({ origin: "ssh://devbox", state: "disconnected" });
    expect(refresh).toHaveBeenCalledWith({ prs: false, quiet: true });
  });

  it("leaves a local tab alone", () => {
    const refresh = vi.fn();
    useRepo.setState({ summary: summary("/local/repo"), refresh });
    renderHook(() => useRemoteSessionEvents());
    emit({ origin: "ssh://devbox", state: "disconnected" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stops listening on unmount", async () => {
    const { unmount } = renderHook(() => useRemoteSessionEvents());
    unmount();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalled();
  });
});
