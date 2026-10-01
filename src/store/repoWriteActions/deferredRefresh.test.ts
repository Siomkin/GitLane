// Conflict-capable writes whose refresh is deferred behind a held `loading`
// (AUDIT item 30): the outcome is read only once the deferral has replayed.

import { emptyIpcInvoke } from "@/test/ipcFixtures";
import type { OperationState } from "@/store/repo";
import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "@/store/repo";
import { flushPendingRefresh } from "@/store/repoGuards";
import { takePendingRefresh } from "@/store/repoRequests";
import { defaultInvoke, emptyGraph, summary } from "@/test/repoFixtures";

const CONFLICT = { path: "f.txt", kind: "text", deletedSide: "" };

const realRefresh = useRepo.getState().refresh;
beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(emptyIpcInvoke);
  takePendingRefresh();
  useRepo.setState({
    summary: { ...summary, headOid: "1111111" },
    branches: [
      { name: "main", kind: "local", target: "1111111", isHead: true, upstream: null, remote: null },
      { name: "feature", kind: "local", target: "2222222", isHead: false, upstream: null, remote: null },
    ],
    operation: null,
    loading: false,
    refresh: realRefresh,
  });
});

/** A Fetch (or any non-quiet load) finishing: `loading` clears and the
 * deferred re-sync replays. */
const releaseLoading = () => {
  useRepo.setState({ loading: false });
  flushPendingRefresh(useRepo.getState);
};

const tick = () => new Promise((resolve) => setTimeout(resolve));

describe("conflict writes with a deferred refresh", () => {
  it("reports a merge that stopped on conflicts once the deferred refresh replays", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "merge_branch":
          return Promise.reject(new Error("CONFLICT (content): Merge conflict in f.txt"));
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        case "operation_status":
          return Promise.resolve({
            kind: "merge",
            canSkip: false,
            conflicts: [CONFLICT],
            advisory: "",
          });
        default:
          return defaultInvoke(cmd);
      }
    });
    useRepo.setState({ loading: true });

    let settled = false;
    const pending = useRepo
      .getState()
      .mergeInto("feature", "main")
      .finally(() => (settled = true));
    await tick();
    // Still waiting: the refresh it asked for was deferred, not run.
    expect(settled).toBe(false);

    releaseLoading();

    await expect(pending).resolves.toMatch(/resolve conflicts to continue/);
    expect(useRepo.getState().operation?.kind).toBe("merge");
  });

  it("keeps the conflict workspace while a failed continue's refresh is deferred", async () => {
    const operation: OperationState = {
      kind: "rebase",
      canSkip: true,
      files: [{ path: "f.txt", kind: "text", deletedSide: "", resolved: true }],
    };
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "continue_operation":
          return Promise.reject(new Error("could not apply 2222222"));
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        case "operation_status":
          return Promise.resolve({
            kind: "rebase",
            canSkip: true,
            conflicts: [{ path: "g.txt", kind: "text", deletedSide: "" }],
            advisory: "",
          });
        default:
          return defaultInvoke(cmd);
      }
    });
    useRepo.setState({ operation, loading: true });

    const pending = useRepo.getState().continueOperation();
    await tick();
    // The union is not cleared ahead of the refresh, so the workspace stays.
    expect(useRepo.getState().operation).toBe(operation);

    releaseLoading();

    await expect(pending).resolves.toBe("Rebase continued — resolve the next conflicts");
    expect(useRepo.getState().operation?.files.find((f) => f.path === "g.txt")?.resolved).toBe(
      false,
    );
  });
});
