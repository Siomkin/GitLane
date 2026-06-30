import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary so the store's remote actions run headlessly. `vi.mock`
// is hoisted above the import below; `vi.hoisted` makes `invokeMock` exist in time.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "./repo";
import type { RepoSummary } from "../lib/api";

const summary: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: null,
  detached: false,
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue("");
  useRepo.setState({ summary: null });
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

    invokeMock.mockResolvedValueOnce([{ name: "origin" }]);
    await expect(listRemotes()).resolves.toEqual([{ name: "origin" }]);
    expect(invokeMock).toHaveBeenLastCalledWith("list_remotes", { path: "/repo" });

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
    await listRemotes();
    expect(invokeMock).toHaveBeenLastCalledWith("list_remotes", { path: "/other" });
  });
});
