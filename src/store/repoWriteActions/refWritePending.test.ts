// Ref writes mark the refs they act on as pending (the pill spinner) for as
// long as they run, and never refuse a checkout while they do.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { BranchKind, type RepoGraph, type RepoSummary, type WorkingChanges } from "@/lib/api";
import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { useRepo } from "@/store/repo";
import type { PendingWriteRef } from "@/lib/checkoutPending";
import { withRefWrite } from "./refWritePending";

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

function deferred<T = string>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const answer = (overrides: Record<string, () => Promise<unknown>> = {}) =>
  invokeMock.mockImplementation((cmd: string) => {
    if (overrides[cmd]) return overrides[cmd]();
    if (cmd === "open_repo") return Promise.resolve(summary);
    if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
    if (cmd === "working_changes") return Promise.resolve(EMPTY_CHANGES);
    return emptyIpcInvoke(cmd);
  });

const pendingRefs = (): PendingWriteRef[] =>
  (useRepo.getState().refWritesPending["/repo"] ?? []).flatMap((w) => [...w.refs]);

/** Start `run` with `cmd` held open; assert the pending refs while it is held,
 *  then release it and assert the record is empty again. */
async function expectPendingDuring(cmd: string, run: () => Promise<unknown>, refs: PendingWriteRef[]) {
  const held = deferred<unknown>();
  let reached = false;
  answer({ [cmd]: () => ((reached = true), held.promise) });
  const op = run();
  await vi.waitFor(() => expect(reached).toBe(true));
  expect(pendingRefs()).toEqual(expect.arrayContaining(refs));
  held.resolve("");
  await op;
  expect(useRepo.getState().refWritesPending).toEqual({});
}

beforeEach(() => {
  invokeMock.mockReset();
  answer();
  useRepo.setState({
    summary,
    remotes: [{ name: "origin", url: "git@example.com:o/r.git", pushUrl: null } as never],
    branches: [
      { name: "feature", kind: BranchKind.Local, target: "aaa1111", isHead: false, upstream: null, remote: null },
      { name: "main", kind: BranchKind.Local, target: "1111111", isHead: true, upstream: null, remote: null },
    ],
    loading: false,
    netOps: 0,
    fetchingPath: null,
    checkoutPending: {},
    refWritesPending: {},
  });
});

describe("withRefWrite", () => {
  const { setState: set, getState: get } = useRepo;

  it("records the refs while the op runs and clears them after success", async () => {
    const held = deferred();
    const op = withRefWrite(set, get, "/repo/", [{ name: "feature", kind: "local" }], () => held.promise);
    // The key is trimmed like checkoutPending's.
    expect(pendingRefs()).toEqual([{ name: "feature", kind: "local" }]);
    held.resolve("ok");
    await expect(op).resolves.toBe("ok");
    expect(get().refWritesPending).toEqual({});
  });

  it("clears its entry and rethrows when the op fails", async () => {
    const op = withRefWrite(set, get, "/repo", [{ name: "v1", kind: "tag" }], () => Promise.reject(new Error("nope")));
    await expect(op).rejects.toThrow("nope");
    expect(get().refWritesPending).toEqual({});
  });

  it("keeps overlapping writes apart and removes only its own entry", async () => {
    const a = deferred();
    const b = deferred();
    const first = withRefWrite(set, get, "/repo", [{ name: "a", kind: "local" }], () => a.promise);
    const second = withRefWrite(set, get, "/repo", [{ name: "b", kind: "local" }], () => b.promise);
    a.resolve("");
    await first;
    expect(pendingRefs()).toEqual([{ name: "b", kind: "local" }]);
    b.resolve("");
    await second;
    expect(get().refWritesPending).toEqual({});
  });
});

describe("store ref writes are pending while they run", () => {
  it("removeBranch", () =>
    expectPendingDuring("delete_branch", () => useRepo.getState().removeBranch("feature", "aaa1111", "/repo", true), [
      { name: "feature", kind: "local" },
    ]));

  it("deleteBranchAndRemote marks both pills", () =>
    expectPendingDuring(
      "delete_remote_branch",
      () => useRepo.getState().deleteBranchAndRemote("feature", "aaa1111", { remote: "origin", branch: "feature", oid: "r" }, "/repo"),
      [
        { name: "feature", kind: "local" },
        { name: "origin/feature", kind: "remote" },
      ],
    ));

  it("deleteBranchWithWorktree", () =>
    expectPendingDuring(
      "delete_branch_with_worktree",
      () => useRepo.getState().deleteBranchWithWorktree("feature", "/wt", "/repo", "aaa1111", "state"),
      [{ name: "feature", kind: "local" }],
    ));

  it("renameBranchTo", () =>
    expectPendingDuring("rename_branch", () => useRepo.getState().renameBranchTo("feature", "renamed"), [
      { name: "feature", kind: "local" },
    ]));

  it("deleteRemoteBranch", () =>
    expectPendingDuring("delete_remote_branch", () => useRepo.getState().deleteRemoteBranch("origin", "feature", "r"), [
      { name: "origin/feature", kind: "remote" },
    ]));

  it("pushBranch", () =>
    expectPendingDuring("push_branch", () => useRepo.getState().pushBranch("feature"), [{ name: "feature", kind: "local" }]));

  it("publishBranch", () =>
    expectPendingDuring("publish_branch", () => useRepo.getState().publishBranch("feature", "origin/feature"), [
      { name: "feature", kind: "local" },
    ]));

  it("deleteTag", () =>
    expectPendingDuring("delete_tag", () => useRepo.getState().deleteTag("v1", "ttt"), [{ name: "v1", kind: "tag" }]));

  it("pushTag", () =>
    expectPendingDuring("push_tag", () => useRepo.getState().pushTag("v1", "origin"), [{ name: "v1", kind: "tag" }]));

  it("clears the entry when the write fails", async () => {
    answer({ push_branch: () => Promise.reject({ kind: "auth", message: "denied" }) });
    await expect(useRepo.getState().pushBranch("feature")).rejects.toBeTruthy();
    expect(useRepo.getState().refWritesPending).toEqual({});
  });
});

describe("a running ref write refuses nothing", () => {
  it("lets a checkout start while a push runs", async () => {
    const held = deferred<unknown>();
    answer({ push_branch: () => held.promise });
    const push = useRepo.getState().pushBranch("feature");
    await vi.waitFor(() => expect(pendingRefs()).toHaveLength(1));

    await expect(useRepo.getState().checkoutBranch("main")).resolves.toBeDefined();
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "checkout")).toBe(true);

    held.resolve("");
    await push;
  });
});

describe("deleteBranchAndRemote keeps the local delete's caveat", () => {
  it("appends what the backend added after the routine text", async () => {
    answer({
      delete_branch: () => Promise.resolve("Deleted feature, but its local branch settings could not be removed: locked"),
    });
    const message = await useRepo
      .getState()
      .deleteBranchAndRemote("feature", "aaa1111", { remote: "origin", branch: "feature", oid: "r" }, "/repo");
    expect(message).toBe(
      "Deleted feature and origin/feature, but its local branch settings could not be removed: locked",
    );
  });
});
