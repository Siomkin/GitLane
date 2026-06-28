import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary so the store's async actions run headlessly.
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

const historyPage = {
  entries: [
    {
      oid: "aaaaaaaaaaaa",
      shortOid: "aaaaaaa",
      subject: "Newest change",
      body: "",
      authorName: "Ada Lovelace",
      authorEmail: "ada@example.test",
      timestamp: 1_700_000_000,
      status: "M",
      path: "src/a.ts",
      add: 3,
      del: 1,
      previousPath: null,
    },
  ],
  nextOffset: 1,
  hasMore: false,
  truncated: false,
};

const fileDiff = { path: "src/a.ts", status: "M", add: 3, del: 1, binary: false, hunks: [], truncated: false };

beforeEach(() => {
  invokeMock.mockReset();
  useRepo.setState({ summary, fileHistory: null, compare: null, selectedCommit: null });
});

describe("repo store — file history", () => {
  it("loads a page, auto-selects the first revision, and fetches its diff", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "file_history") return Promise.resolve(historyPage);
      if (cmd === "commit_file_diff") return Promise.resolve(fileDiff);
      return Promise.resolve(null);
    });

    await useRepo.getState().openFileHistory("src/a.ts");

    const fh = useRepo.getState().fileHistory!;
    expect(fh.path).toBe("src/a.ts");
    expect(fh.entries).toHaveLength(1);
    expect(fh.selectedOid).toBe("aaaaaaaaaaaa");
    expect(invokeMock).toHaveBeenCalledWith("file_history", {
      path: "/repo",
      file: "src/a.ts",
      offset: 0,
      limit: 100,
    });
  });

  it("opening file history clears any active compare", async () => {
    useRepo.setState({ compare: { base: "x" } as never });
    invokeMock.mockResolvedValue(historyPage);
    await useRepo.getState().openFileHistory("src/a.ts");
    expect(useRepo.getState().compare).toBeNull();
  });
});

describe("repo store — compare", () => {
  const compareResult = {
    files: [
      { path: "src/a.ts", status: "M", add: 2, del: 1 },
      { path: "src/b.ts", status: "A", add: 9, del: 0 },
    ],
    add: 11,
    del: 1,
    ahead: 3,
    behind: 0,
  };

  it("opens a ref comparison, stores totals, and auto-selects the first file", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "compare_refs") return Promise.resolve(compareResult);
      if (cmd === "compare_file_diff") return Promise.resolve(fileDiff);
      return Promise.resolve(null);
    });

    await useRepo.getState().openCompare({
      base: "origin/main",
      head: "feature",
      baseLabel: "origin/main",
      headLabel: "feature",
      scope: "upstream",
      title: "Comparing feature with origin/main",
    });

    const cmp = useRepo.getState().compare!;
    expect(cmp.files).toHaveLength(2);
    expect(cmp.add).toBe(11);
    expect(cmp.ahead).toBe(3);
    expect(cmp.selectedPath).toBe("src/a.ts");
    expect(invokeMock).toHaveBeenCalledWith("compare_refs", {
      path: "/repo",
      base: "origin/main",
      head: "feature",
    });
  });

  it("compares against the working tree with head: null", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "compare_refs") return Promise.resolve({ ...compareResult, ahead: 0 });
      if (cmd === "compare_file_diff") return Promise.resolve(fileDiff);
      return Promise.resolve(null);
    });

    await useRepo.getState().openCompare({
      base: "abc1234",
      head: null,
      baseLabel: "abc1234",
      headLabel: "Working tree",
      scope: "working",
      title: "Comparing abc1234 with the working tree",
    });

    expect(useRepo.getState().compare!.head).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("compare_refs", {
      path: "/repo",
      base: "abc1234",
      head: null,
    });
  });

  it("path filter is applied to the file list non-destructively", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "compare_refs") return Promise.resolve(compareResult);
      if (cmd === "compare_file_diff") return Promise.resolve(fileDiff);
      return Promise.resolve(null);
    });
    await useRepo.getState().openCompare({
      base: "main",
      head: "feature",
      baseLabel: "main",
      headLabel: "feature",
      scope: "branch",
      title: "t",
    });
    useRepo.getState().setComparePathFilter("b.ts");
    // The filter is stored; the full file set is untouched.
    expect(useRepo.getState().compare!.pathFilter).toBe("b.ts");
    expect(useRepo.getState().compare!.files).toHaveLength(2);
  });
});
