import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { remoteApi } from "./remote";

afterEach(() => invokeMock.mockReset());

describe("remoteApi", () => {
  it("connects by locator and returns the host's home and git", async () => {
    invokeMock.mockResolvedValueOnce({
      origin: "ssh://devbox",
      home: "/home/me",
      git: "git version 2.53.0",
    });
    await expect(remoteApi.remoteConnect("ssh://devbox/srv/app")).resolves.toEqual({
      origin: "ssh://devbox",
      home: "/home/me",
      git: "git version 2.53.0",
    });
    expect(invokeMock).toHaveBeenCalledWith("remote_connect", { locator: "ssh://devbox/srv/app" });
  });

  it("tests a form's connection, key file included, through its own command", async () => {
    invokeMock.mockResolvedValueOnce({ origin: "ssh://devbox", home: null, git: null });
    await remoteApi.testSshConnection("ssh://devbox/", "~/.ssh/dev");
    expect(invokeMock).toHaveBeenCalledWith("test_ssh_connection", { locator: "ssh://devbox/", identityFile: "~/.ssh/dev" });
  });

  it("lists the ssh questions still waiting", async () => {
    const prompt = { id: 3, origin: "ssh://devbox", prompt: "password: ", kind: "secret" };
    invokeMock.mockResolvedValueOnce([prompt]);
    await expect(remoteApi.listSshPrompts()).resolves.toEqual([prompt]);
    expect(invokeMock).toHaveBeenLastCalledWith("list_ssh_prompts");
  });

  it("lists, saves and deletes saved connections, validating each answer", async () => {
    const work = { name: "Work", host: "build.example", user: "me", port: null, identityFile: null };
    invokeMock.mockResolvedValue([work]);
    await expect(remoteApi.listSshConnections()).resolves.toEqual([work]);
    await remoteApi.saveSshConnection(null, work);
    expect(invokeMock).toHaveBeenLastCalledWith("save_ssh_connection", { previousOrigin: null, connection: work });
    await remoteApi.deleteSshConnection("ssh://me@build.example");
    expect(invokeMock).toHaveBeenLastCalledWith("delete_ssh_connection", { origin: "ssh://me@build.example" });
    invokeMock.mockResolvedValueOnce([{ name: 1 }]);
    await expect(remoteApi.listSshConnections()).rejects.toThrow();
  });

  it("rejects a malformed connect response at the seam", async () => {
    invokeMock.mockResolvedValueOnce({ origin: 7 });
    await expect(remoteApi.remoteConnect("ssh://devbox/srv/app")).rejects.toThrow();
  });

  it("lists ssh hosts and disconnects by locator", async () => {
    invokeMock.mockResolvedValueOnce(["devbox", "ci"]);
    await expect(remoteApi.listSshHosts()).resolves.toEqual(["devbox", "ci"]);
    expect(invokeMock).toHaveBeenLastCalledWith("list_ssh_hosts");

    invokeMock.mockResolvedValueOnce(null);
    await remoteApi.remoteDisconnect("ssh://devbox/srv/app");
    expect(invokeMock).toHaveBeenLastCalledWith("remote_disconnect", {
      locator: "ssh://devbox/srv/app",
    });
  });
});
