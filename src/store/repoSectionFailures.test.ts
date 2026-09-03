// unify-error-model 4.1: a secondary refresh read that fails (stashes,
// worktrees, forge, remotes, operation status) keeps its last good data, flags
// the section unavailable, and raises ONE notification — never blanks the
// section as if the repo had none. The flag and toast clear on the next
// successful read of that section.

import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "./repo";
import { createInitialRepoData } from "./repoTypes";
import { useNotifications } from "./notifications";
import type {
  OperationStatus,
  RepoGraph,
  RepoSummary,
  StashEntry,
  WorkingChanges,
  WorktreeInfo,
} from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";

const summary: RepoSummary = {
  path: "/r",
  workdir: "/r",
  headBranch: "main",
  headOid: null,
  detached: false,
};
const emptyGraph: RepoGraph = {
  commits: [],
  edges: [],
  laneCount: 1,
  wipLane: null,
  head: null,
  truncated: false,
};
const EMPTY_CHANGES: WorkingChanges = {
  staged: [],
  unstaged: [],
  conflicted: [],
  advanced: emptyAdvancedState,
};
const idle: OperationStatus = { kind: "none", canSkip: false, conflicts: [], advisory: "" };
const stash = (index: number): StashEntry => ({
  index,
  message: `wip ${index}`,
  oid: `s${index}`,
  timestamp: 0,
  baseOid: "c1",
  baseTimestamp: 0,
  context: [],
});
const worktree: WorktreeInfo = { name: "wt", path: "/wt", branch: "feature", isMain: false };

/** Every read succeeds except the commands listed in `failing`, which reject
 * with the given error (an `Error` or a structured `{ message }`). */
const invokeWith =
  (failing: Record<string, unknown>, stashes: StashEntry[] = [stash(0)]) =>
  (cmd: string): Promise<unknown> => {
    if (cmd in failing) return Promise.reject(failing[cmd]);
    switch (cmd) {
      case "open_repo":
        return Promise.resolve(summary);
      case "commit_graph":
        return Promise.resolve(emptyGraph);
      case "working_changes":
        return Promise.resolve(EMPTY_CHANGES);
      case "operation_status":
        return Promise.resolve(idle);
      case "list_stashes":
        return Promise.resolve(stashes);
      case "list_worktrees":
        return Promise.resolve([worktree]);
      case "repo_forge":
        return Promise.resolve({ provider: "github", host: "github.com", owner: "o", repo: "r" });
      default:
        return Promise.resolve([]);
    }
  };

const titles = () => useNotifications.getState().toasts.map((t) => t.title);
const count = (title: string) => titles().filter((t) => t === title).length;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  localStorage.clear();
  useNotifications.setState({ toasts: [] });
  useRepo.setState({
    ...createInitialRepoData([summary.path], []),
    summary,
    graph: emptyGraph,
    stashes: [stash(0), stash(1)],
    worktrees: [worktree],
  });
});

describe("repo store — failed secondary reads are surfaced, not blanked", () => {
  it("keeps the previous stashes and worktrees and flags each section when its read rejects", async () => {
    invokeMock.mockImplementation(
      invokeWith({
        list_stashes: new Error("stash list failed"),
        list_worktrees: { kind: "internal", message: "worktree list failed" },
      }),
    );

    await useRepo.getState().refresh({ prs: false });

    const s = useRepo.getState();
    expect(s.error).toBeNull();
    expect(s.stashes).toEqual([stash(0), stash(1)]);
    expect(s.worktrees).toEqual([worktree]);
    expect(s.unavailableSections).toEqual({
      stashes: "stash list failed",
      worktrees: "worktree list failed",
    });
    expect(count("Couldn't read stashes")).toBe(1);
    expect(count("Couldn't read worktrees")).toBe(1);
    expect(useNotifications.getState().toasts.map((t) => t.kind)).toEqual(["warning", "warning"]);
  });

  it("raises exactly one notification per failing section across consecutive failing refreshes", async () => {
    invokeMock.mockImplementation(invokeWith({ list_stashes: new Error("boom") }));

    await useRepo.getState().refresh({ prs: false });
    await useRepo.getState().refresh({ prs: false });

    expect(count("Couldn't read stashes")).toBe(1);
    expect(useRepo.getState().unavailableSections).toEqual({ stashes: "boom" });
    // The healthy sections were refreshed normally alongside the failing one.
    expect(useRepo.getState().worktrees).toEqual([worktree]);
  });

  it("clears the flag, dismisses the notification, and publishes fresh data once the read succeeds", async () => {
    invokeMock.mockImplementation(invokeWith({ list_stashes: new Error("boom") }));
    await useRepo.getState().refresh({ prs: false });
    expect(useRepo.getState().unavailableSections).toEqual({ stashes: "boom" });
    expect(count("Couldn't read stashes")).toBe(1);

    invokeMock.mockImplementation(invokeWith({}, [stash(7)]));
    await useRepo.getState().refresh({ prs: false });

    const s = useRepo.getState();
    expect(s.unavailableSections).toEqual({});
    expect(s.stashes).toEqual([stash(7)]);
    expect(count("Couldn't read stashes")).toBe(0);
  });

  it("keeps the previous forge and remotes when those reads reject", async () => {
    const forge = { provider: "gitlab", host: "gitlab.com", owner: "o", repo: "r" };
    useRepo.setState({
      forge: forge as never,
      remotes: [{ name: "origin", url: "git@example.com:o/r.git" } as never],
    });
    invokeMock.mockImplementation(
      invokeWith({ repo_forge: new Error("forge failed"), list_remotes: new Error("remotes failed") }),
    );

    await useRepo.getState().refresh({ prs: false });

    const s = useRepo.getState();
    expect(s.forge).toEqual(forge);
    expect(s.remotes).toHaveLength(1);
    expect(s.unavailableSections).toEqual({ forge: "forge failed", remotes: "remotes failed" });
    expect(count("Couldn't read the hosting provider")).toBe(1);
    expect(count("Couldn't read remotes")).toBe(1);
  });

  it("flags the operation status on a worktree-scope refresh and keeps the prior advisory", async () => {
    useRepo.setState({ operationAdvisory: "bisect" });
    invokeMock.mockImplementation(invokeWith({ operation_status: new Error("status failed") }));

    await useRepo.getState().refresh({ prs: false, scope: "worktree", quiet: true });
    await useRepo.getState().refresh({ prs: false, scope: "worktree", quiet: true });

    const s = useRepo.getState();
    expect(s.operationAdvisory).toBe("bisect");
    expect(s.unavailableSections).toEqual({ operation: "status failed" });
    expect(count("Couldn't read the operation status")).toBe(1);

    invokeMock.mockImplementation(invokeWith({}));
    await useRepo.getState().refresh({ prs: false, scope: "worktree", quiet: true });
    expect(useRepo.getState().unavailableSections).toEqual({});
    expect(useRepo.getState().operationAdvisory).toBeNull();
    expect(count("Couldn't read the operation status")).toBe(0);
  });

  it("keeps the unavailable map's identity across a healthy refresh", async () => {
    invokeMock.mockImplementation(invokeWith({}));
    const before = useRepo.getState().unavailableSections;

    await useRepo.getState().refresh({ prs: false });

    expect(useRepo.getState().unavailableSections).toBe(before);
    expect(titles()).toEqual([]);
  });
});
