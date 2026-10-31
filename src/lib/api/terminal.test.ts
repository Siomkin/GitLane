import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { terminalApi } from "./terminal";

afterEach(() => invokeMock.mockReset());

describe("terminalApi.ptySpawn", () => {
  it("starts a local shell in the repository's path", async () => {
    invokeMock.mockResolvedValueOnce({ sessionId: 4 });
    await expect(terminalApi.ptySpawn("/Users/me/app", 80, 24)).resolves.toEqual({ sessionId: 4 });
    expect(invokeMock).toHaveBeenCalledWith("pty_spawn", { path: "/Users/me/app", cols: 80, rows: 24 });
  });

  it("starts a remote repository's terminal on this computer, never through the agent", async () => {
    invokeMock.mockResolvedValueOnce({ sessionId: 5 });
    await expect(terminalApi.ptySpawn("ssh://devbox/srv/app", 80, 24)).resolves.toEqual({ sessionId: 5 });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("pty_spawn_remote", {
      locator: "ssh://devbox/srv/app",
      cols: 80,
      rows: 24,
    });
  });
});
