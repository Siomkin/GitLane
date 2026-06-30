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

  it("does not publish a history response after the repo was switched", async () => {
    let resolveHistory!: (value: unknown) => void;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "file_history") return new Promise((res) => (resolveHistory = res));
      return Promise.resolve(fileDiff);
    });

    const pending = useRepo.getState().openFileHistory("src/a.ts");
    // The user switches to another repo while the request is in flight, and
    // opens the same relative path there.
    useRepo.setState({ summary: { ...summary, path: "/other-repo" }, fileHistory: null });
    resolveHistory(historyPage);
    await pending;

    // Repo A's response must not populate repo B's (now cleared) inspection view.
    expect(useRepo.getState().fileHistory).toBeNull();
  });

  it("routes blame failures to blameError, leaving the history list intact", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "file_history") return Promise.resolve(historyPage);
      if (cmd === "commit_file_diff") return Promise.resolve(fileDiff);
      if (cmd === "file_blame") return Promise.reject("fatal: no such path");
      return Promise.resolve(null);
    });

    await useRepo.getState().openFileHistory("src/a.ts");
    await useRepo.getState().loadFileBlame();

    const fh = useRepo.getState().fileHistory!;
    expect(fh.blameError).toContain("no such path");
    expect(fh.error).toBeNull(); // history list stays usable
    expect(fh.entries).toHaveLength(1);
  });

  it("blames the historical path passed for a renamed revision", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "file_history") return Promise.resolve(historyPage);
      if (cmd === "commit_file_diff") return Promise.resolve(fileDiff);
      if (cmd === "file_blame")
        return Promise.resolve({ path: "old/a.ts", revision: "aaaaaaaaaaaa", binary: false, truncated: false, lines: [] });
      return Promise.resolve(null);
    });

    await useRepo.getState().openFileHistory("src/a.ts");
    await useRepo.getState().loadFileBlame("aaaaaaaaaaaa", "old/a.ts");

    expect(invokeMock).toHaveBeenCalledWith("file_blame", {
      path: "/repo",
      file: "old/a.ts",
      revision: "aaaaaaaaaaaa",
      limit: null,
    });
  });
});

describe("repo store — compare", () => {
  const compareResult = {
    files: [
      { path: "src/a.ts", status: "M", add: 2, del: 1, binary: false },
      { path: "src/b.ts", status: "A", add: 9, del: 0, binary: false },
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

  it("refreshCompare re-fetches the file set in place and keeps the selection", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "compare_refs") return Promise.resolve(compareResult);
      if (cmd === "compare_file_diff") return Promise.resolve(fileDiff);
      return Promise.resolve(null);
    });
    await useRepo.getState().openCompare({
      base: "abc",
      head: null,
      baseLabel: "abc",
      headLabel: "Working tree",
      scope: "working",
      title: "t",
    });
    useRepo.getState().selectCompareFile("src/b.ts");
    await Promise.resolve();

    // Working tree changed: now only one file differs.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "compare_refs")
        return Promise.resolve({ files: [{ path: "src/b.ts", status: "M", add: 1, del: 0, binary: false }], add: 1, del: 0, ahead: 0, behind: 0 });
      if (cmd === "compare_file_diff") return Promise.resolve(fileDiff);
      return Promise.resolve(null);
    });
    await useRepo.getState().refreshCompare();

    const cmp = useRepo.getState().compare!;
    expect(cmp.files).toHaveLength(1);
    expect(cmp.add).toBe(1);
    expect(cmp.selectedPath).toBe("src/b.ts"); // selection preserved
  });

  it("refreshCompare does not override a selection made while it was in flight", async () => {
    let resolveRefresh!: (value: unknown) => void;
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
    // Default selection is the first file (src/a.ts).
    expect(useRepo.getState().compare!.selectedPath).toBe("src/a.ts");

    // Start a background refresh whose compare_refs is held open.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "compare_refs") return new Promise((res) => (resolveRefresh = res));
      if (cmd === "compare_file_diff") return Promise.resolve(fileDiff);
      return Promise.resolve(null);
    });
    const refreshing = useRepo.getState().refreshCompare();
    // User picks another file while the refresh is in flight.
    await useRepo.getState().selectCompareFile("src/b.ts");
    resolveRefresh(compareResult);
    await refreshing;

    expect(useRepo.getState().compare!.selectedPath).toBe("src/b.ts");
  });

  it("routes per-file diff failures to diffError, keeping the file list", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "compare_refs") return Promise.resolve(compareResult);
      if (cmd === "compare_file_diff") return Promise.reject("fatal: bad object");
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

    // The per-file diff is fetched fire-and-forget so the file list paints
    // immediately; drain the in-flight fetch before asserting its failure.
    await new Promise((resolve) => setTimeout(resolve));

    const cmp = useRepo.getState().compare!;
    expect(cmp.diffError).toContain("bad object");
    expect(cmp.error).toBeNull();
    expect(cmp.files).toHaveLength(2);
  });
});
