import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { connectionFor, connectionOrigin, remoteSessionOf, useRemoteSessions } from "./remoteSessions";

const WORK = { name: "Work", host: "build.example", user: "me", port: 2222, identityFile: null };

beforeEach(() => {
  invokeMock.mockReset();
  useRemoteSessions.setState({ connections: [], prompts: [] });
});

describe("remoteSessions", () => {
  it("keeps the latest state per host", () => {
    const { apply } = useRemoteSessions.getState();
    apply({ origin: "ssh://devbox", state: "connecting" });
    apply({ origin: "ssh://devbox", state: "installing", progress: { stage: "uploading", percent: 40 } });
    apply({ origin: "ssh://ci", state: "connected" });

    const state = useRemoteSessions.getState();
    expect(remoteSessionOf("ssh://devbox")(state)).toEqual({
      state: "installing",
      progress: { stage: "uploading", percent: 40 },
    });
    expect(remoteSessionOf("ssh://ci")(state)?.state).toBe("connected");
    expect(remoteSessionOf("ssh://other")(state)).toBeUndefined();
  });

  it("spells a connection's origin the way Rust's Locator does", () => {
    expect(connectionOrigin(WORK)).toBe("ssh://me@build.example:2222");
    expect(connectionOrigin({ host: "devbox", user: null, port: null })).toBe("ssh://devbox");
    expect(connectionOrigin({ host: "::1", user: null, port: 22 })).toBe("ssh://[::1]:22");
  });

  it("loads, saves and deletes connections through the backend's answers", async () => {
    const store = useRemoteSessions.getState();
    invokeMock.mockResolvedValueOnce([WORK]);
    await store.loadConnections();
    expect(connectionFor("ssh://me@build.example:2222")(useRemoteSessions.getState())?.name).toBe("Work");

    invokeMock.mockResolvedValueOnce([{ ...WORK, name: "Build" }]);
    await store.saveConnection("ssh://me@build.example:2222", { ...WORK, name: "Build" });
    expect(useRemoteSessions.getState().connections[0].name).toBe("Build");

    invokeMock.mockResolvedValueOnce([]);
    await store.deleteConnection("ssh://me@build.example:2222");
    expect(useRemoteSessions.getState().connections).toEqual([]);

    // A failed load keeps what was there.
    useRemoteSessions.setState({ connections: [WORK] });
    invokeMock.mockRejectedValueOnce(new Error("no app data"));
    await store.loadConnections();
    expect(useRemoteSessions.getState().connections).toEqual([WORK]);
  });

  it("ends an unused session but leaves one an open tab still needs", async () => {
    const { releaseUnused } = useRemoteSessions.getState();
    invokeMock.mockResolvedValue(undefined);
    await releaseUnused("ssh://devbox", ["ssh://devbox/srv/app"]);
    expect(invokeMock).not.toHaveBeenCalled();
    await releaseUnused("ssh://devbox", ["/local", "ssh://devbox2/x"]);
    expect(invokeMock).toHaveBeenCalledWith("remote_disconnect", { locator: "ssh://devbox/" });
  });

  it("queues ssh questions and drops one once it is answered", async () => {
    const store = useRemoteSessions.getState();
    store.addPrompt({ id: 1, origin: "ssh://devbox", prompt: "password: ", kind: "secret" });
    invokeMock.mockResolvedValue(undefined);
    await store.answerPrompt(1, "pw");
    expect(useRemoteSessions.getState().prompts).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("answer_ssh_prompt", { id: 1, secretAnswer: "pw" });
  });
});
