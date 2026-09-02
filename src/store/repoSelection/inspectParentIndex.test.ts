import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchKind, type CommitNode, type RepoGraph } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "@/store/repo";

const summary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "my-feature",
  headOid: "ccc3333ffffff",
  detached: false,
};

const node = (over: Partial<CommitNode>): CommitNode => ({
  id: "c",
  shortId: "c",
  summary: "",
  body: "",
  authorName: "",
  authorEmail: "",
  timestamp: 0,
  parents: [],
  lane: 0,
  row: 0,
  refs: [],
  ...over,
});

const merge = node({
  id: "ccc3333ffffff",
  shortId: "ccc3333",
  summary: "Merged develop into my-feature",
  parents: ["aaa1111ffffff", "bbb2222ffffff"],
});
const other = node({ id: "aaaaaaa", shortId: "aaaaaaa", parents: ["bbbbbbb"] });

const graph: RepoGraph = {
  commits: [merge, other],
  edges: [],
  laneCount: 1,
  wipLane: null,
  head: "ccc3333ffffff",
  truncated: false,
};

const fileDiff = (path: string) => ({
  path,
  status: "M" as const,
  add: 1,
  del: 0,
  binary: false,
  hunks: [],
  truncated: false,
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "working_changes") {
      return Promise.resolve({
        staged: [],
        unstaged: [],
        conflicted: [],
        advanced: emptyAdvancedState,
      });
    }
    if (cmd === "commit_files") {
      return Promise.resolve([{ path: "incoming/a.ts", status: "M", add: 1, del: 0, binary: false }]);
    }
    if (cmd === "diff_range") {
      return Promise.resolve([{ path: "ticket/a.ts", status: "M", add: 1, del: 0, binary: false }]);
    }
    if (cmd === "commit_file_diff") return Promise.resolve(fileDiff("incoming/a.ts"));
    if (cmd === "diff_range_file") return Promise.resolve(fileDiff("ticket/a.ts"));
    return Promise.resolve([]);
  });
  useRepo.setState({
    summary,
    graph,
    stashes: [],
    selectedCommit: "ccc3333ffffff",
    selectedCommits: ["ccc3333ffffff"],
    inspectParentIndex: 0,
    commitFiles: [],
    selectedFile: null,
    fileDiff: null,
    wipSelected: false,
    selectionDiff: null,
    branches: [
      {
        name: "develop",
        kind: BranchKind.Local,
        target: "bbb2222ffffff",
        isHead: false,
        upstream: null,
        remote: null,
      },
    ],
  });
});

describe("inspectParentIndex", () => {
  it("resets to first parent and loads commit_files when the selected commit changes", async () => {
    useRepo.setState({ inspectParentIndex: 1 });
    await useRepo.getState().selectCommit("aaaaaaa");
    expect(useRepo.getState().inspectParentIndex).toBe(0);
    expect(invokeMock).toHaveBeenCalledWith("commit_files", {
      path: "/repo",
      oid: "aaaaaaa",
    });
    expect(useRepo.getState().commitFiles).toEqual([
      { path: "incoming/a.ts", status: "M", add: 1, del: 0, binary: false },
    ]);
  });

  it("loads diff_range against the chosen parent and hunks via diff_range_file", async () => {
    await useRepo.getState().setInspectParentIndex(1);
    expect(useRepo.getState().inspectParentIndex).toBe(1);
    expect(invokeMock).toHaveBeenCalledWith("diff_range", {
      path: "/repo",
      base: "bbb2222ffffff",
      head: "ccc3333ffffff",
    });
    expect(useRepo.getState().commitFiles).toEqual([
      { path: "ticket/a.ts", status: "M", add: 1, del: 0, binary: false },
    ]);

    await useRepo.getState().selectFile("ticket/a.ts", "commit");
    expect(invokeMock).toHaveBeenCalledWith(
      "diff_range_file",
      expect.objectContaining({
        path: "/repo",
        base: "bbb2222ffffff",
        head: "ccc3333ffffff",
        file: "ticket/a.ts",
      }),
    );
    expect(useRepo.getState().fileDiff?.path).toBe("ticket/a.ts");
  });

  it("does not switch parent on a stash", async () => {
    useRepo.setState({
      selectedCommit: "stash-oid",
      selectedCommits: ["stash-oid"],
      stashes: [
        {
          index: 0,
          message: "WIP",
          oid: "stash-oid",
          timestamp: 1,
          baseOid: "base",
          baseTimestamp: 1,
          context: [],
        },
      ],
      inspectParentIndex: 0,
    });
    invokeMock.mockClear();
    await useRepo.getState().setInspectParentIndex(1);
    expect(useRepo.getState().inspectParentIndex).toBe(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
