// The combined local + remote branch delete: remote first, local only after it,
// both on the confirmed repository, with one honest message per outcome.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import type { RepoGraph, RepoSummary, WorkingChanges } from "@/lib/api";
import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { useRepo } from "@/store/repo";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const summary: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: "1111111",
  detached: false,
  unborn: false,
  isWorktree: false,
};
const emptyGraph: RepoGraph = { commits: [], edges: [], laneCount: 1, wipLane: null, head: null, truncated: false };
const EMPTY_CHANGES: WorkingChanges = { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState };

const target = { remote: "origin", branch: "feature", oid: "remote-oid" };
const writes = () =>
  invokeMock.mock.calls.map(([cmd]) => cmd as string).filter((cmd) => cmd.startsWith("delete_"));

const answer = (overrides: Record<string, () => Promise<unknown>> = {}) =>
  invokeMock.mockImplementation((cmd: string) => {
    if (overrides[cmd]) return overrides[cmd]();
    if (cmd === "open_repo") return Promise.resolve(summary);
    if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
    if (cmd === "working_changes") return Promise.resolve(EMPTY_CHANGES);
    return emptyIpcInvoke(cmd);
  });

beforeEach(() => {
  invokeMock.mockReset();
  answer();
  useRepo.setState({ summary, remotes: [], branches: [], loading: false, netOps: 0, fetchingPath: null });
});

describe("deleteBranchAndRemote", () => {
  it("deletes the remote branch, then the local one, on the confirmed repo", async () => {
    const message = await useRepo.getState().deleteBranchAndRemote("feature", "local-oid", target, "/repo");

    expect(message).toBe("Deleted feature and origin/feature");
    expect(writes()).toEqual(["delete_remote_branch", "delete_branch"]);
    expect(invokeMock).toHaveBeenCalledWith(
      "delete_remote_branch",
      expect.objectContaining({ path: "/repo", remote: "origin", branch: "feature", expectedOid: "remote-oid" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("delete_branch", {
      path: "/repo",
      name: "feature",
      expectedOid: "local-oid",
      force: true,
    });
  });

  it("reports each step as it starts, after the previous one finished", async () => {
    const seen: string[] = [];
    answer({
      delete_remote_branch: () => (seen.push("remote ran"), Promise.resolve("")),
      delete_branch: () => (seen.push("local ran"), Promise.resolve("")),
    });

    await useRepo.getState().deleteBranchAndRemote("feature", "local-oid", target, "/repo", (step) => seen.push(step));

    expect(seen).toEqual(["remote ran", "local", "local ran", "refresh"]);
  });

  it("deletes nothing locally when the remote delete fails", async () => {
    answer({ delete_remote_branch: () => Promise.reject({ kind: "auth", message: "Permission denied" }) });

    const run = useRepo.getState().deleteBranchAndRemote("feature", "local-oid", target, "/repo");

    // The original failure rides along untouched, so the toast keeps its kind and copy.
    await expect(run).rejects.toMatchObject({
      outcome: "Nothing was deleted: origin/feature could not be deleted.",
      failure: { kind: "auth", message: "Permission denied" },
    });
    expect(writes()).toEqual(["delete_remote_branch"]);
  });

  it("names both outcomes when the local delete fails after the remote one", async () => {
    answer({ delete_branch: () => Promise.reject({ kind: "git", message: "feature moved since the preview" }) });

    const run = useRepo.getState().deleteBranchAndRemote("feature", "local-oid", target, "/repo");

    await expect(run).rejects.toThrow(/origin\/feature was deleted, but feature was kept\. .*moved since the preview/);
    expect(writes()).toEqual(["delete_remote_branch", "delete_branch"]);
  });

  it("refuses the local delete when the active repo changed mid-run", async () => {
    answer({
      delete_remote_branch: () => {
        useRepo.setState({ summary: { ...summary, path: "/other", workdir: "/other" } });
        return Promise.resolve("");
      },
    });

    const run = useRepo.getState().deleteBranchAndRemote("feature", "local-oid", target, "/repo");

    await expect(run).rejects.toThrow(/origin\/feature was deleted, but feature was kept\. .*repository changed/i);
    expect(writes()).toEqual(["delete_remote_branch"]);
  });

  it("refuses to start against a repo that is no longer active", async () => {
    await expect(
      useRepo.getState().deleteBranchAndRemote("feature", "local-oid", target, "/elsewhere"),
    ).rejects.toThrow(/Repository changed/);
    expect(writes()).toEqual([]);
  });
});
