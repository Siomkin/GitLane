import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary so the store's remote actions run headlessly. `vi.mock`
// is hoisted above the import below; `vi.hoisted` makes `invokeMock` exist in time.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "./repo";
import type { RepoSummary } from "@/lib/api";

const summary: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: null,
  detached: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue("");
  useRepo.setState({ summary: null, remotes: [] });
});

describe("repoRemoteActions", () => {
  // The actions are public on `useRepo` (RemotesPanel guards `!summary` itself,
  // but a future caller might not), so the no-repo guard is part of the contract.
  it("rejects every action with 'No repository' when no repo is open", async () => {
    const { listRemotes, addRemote, setRemoteUrl, removeRemote } = useRepo.getState();
    await expect(listRemotes()).rejects.toThrow("No repository");
    await expect(addRemote("upstream", "url")).rejects.toThrow("No repository");
    await expect(setRemoteUrl("origin", "url")).rejects.toThrow("No repository");
    await expect(removeRemote("origin")).rejects.toThrow("No repository");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("routes each action to the matching command with the open repo's path", async () => {
    useRepo.setState({ summary });
    const { listRemotes, addRemote, setRemoteUrl, removeRemote } = useRepo.getState();

    const origin = {
      name: "origin",
      fetchUrl: "https://example.com/o/r.git",
      pushUrl: "https://example.com/o/r.git",
      isDefault: true,
    };
    invokeMock.mockResolvedValueOnce([origin]);
    await expect(listRemotes()).resolves.toEqual([origin]);
    // Not the *last* call: publishing the list re-resolves the per-remote
    // account bindings (GL-129), which reads the repo identity afterwards.
    expect(invokeMock).toHaveBeenCalledWith("list_remotes", { path: "/repo" });
    expect(useRepo.getState().remotes).toEqual([origin]);

    await addRemote("upstream", "https://example.com/u/r.git");
    expect(invokeMock).toHaveBeenLastCalledWith("add_remote", {
      path: "/repo",
      name: "upstream",
      url: "https://example.com/u/r.git",
    });

    await setRemoteUrl("origin", "https://example.com/me/changed.git");
    expect(invokeMock).toHaveBeenLastCalledWith("set_remote_url", {
      path: "/repo",
      name: "origin",
      url: "https://example.com/me/changed.git",
    });

    await removeRemote("origin");
    expect(invokeMock).toHaveBeenLastCalledWith("remove_remote", { path: "/repo", name: "origin" });
  });

  it("resolves the path at call time, so a repo switch retargets the action", async () => {
    useRepo.setState({ summary });
    const { listRemotes } = useRepo.getState();
    useRepo.setState({ summary: { ...summary, path: "/other" } });
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "list_remotes" ? [] : ""),
    );
    await listRemotes();
    expect(invokeMock).toHaveBeenCalledWith("list_remotes", { path: "/other" });
  });

  it("publishes and returns only the latest overlapping remote list", async () => {
    useRepo.setState({ summary, remotes: [] });
    const slow = deferred<never[]>();
    const newest = [{
      name: "upstream",
      fetchUrl: "https://example.com/new.git",
      pushUrl: "https://example.com/new.git",
      isDefault: true,
    }];
    let calls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd !== "list_remotes") return Promise.resolve("");
      calls += 1;
      return calls === 1 ? slow.promise : Promise.resolve(newest);
    });

    const oldLoad = useRepo.getState().listRemotes();
    await expect(useRepo.getState().listRemotes()).resolves.toEqual(newest);
    slow.resolve([]);

    await expect(oldLoad).resolves.toEqual(newest);
    expect(useRepo.getState().remotes).toEqual(newest);
  });

  it("neutralizes a stale remote-list rejection after a newer success", async () => {
    useRepo.setState({ summary, remotes: [] });
    const slow = deferred<never[]>();
    const newest = [{
      name: "origin",
      fetchUrl: "https://example.com/new.git",
      pushUrl: "https://example.com/new.git",
      isDefault: true,
    }];
    let calls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd !== "list_remotes") return Promise.resolve("");
      calls += 1;
      return calls === 1 ? slow.promise : Promise.resolve(newest);
    });

    const stale = useRepo.getState().listRemotes();
    await useRepo.getState().listRemotes();
    slow.reject(new Error("old remote failure"));

    await expect(stale).resolves.toEqual(newest);
    expect(useRepo.getState().remotes).toEqual(newest);
  });
});
