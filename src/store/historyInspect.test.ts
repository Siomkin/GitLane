import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary so the store's async actions run headlessly.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "./repo";
import { useUi } from "./ui";
import { beginPublishedRepoSession } from "./repoRequests";
import type { FileBlame, FileDiff, FileHistoryPage, RepoSummary } from "@/lib/api";
import type { FileHistoryState } from "./repoTypes";

const summary: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: null,
  detached: false,
};

const historyPage: FileHistoryPage = {
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

const fileDiff: FileDiff = {
  path: "src/a.ts",
  status: "M",
  add: 3,
  del: 1,
  binary: false,
  hunks: [],
  truncated: false,
};

const pageFor = (
  oid: string,
  subject: string,
  path = "src/a.ts",
  over: Partial<FileHistoryPage> = {},
): FileHistoryPage => ({
  ...historyPage,
  entries: [{ ...historyPage.entries[0], oid, shortOid: oid.slice(0, 7), subject, path }],
  ...over,
});

const historyState = (over: Partial<FileHistoryState> = {}): FileHistoryState => ({
  path: "src/a.ts",
  mode: "history",
  entries: historyPage.entries,
  loading: false,
  loadingMore: false,
  error: null,
  hasMore: false,
  nextOffset: 1,
  truncated: false,
  selectedOid: historyPage.entries[0].oid,
  selectedPath: historyPage.entries[0].path,
  selectedDiff: fileDiff,
  diffLoading: false,
  diffError: null,
  blame: null,
  blameLoading: false,
  blameError: null,
  blameRevision: null,
  blamePath: null,
  blameSelectedOid: null,
  ...over,
});

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
  beginPublishedRepoSession();
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

  it("clears a superseded foreground diff spinner when opening history", async () => {
    const page = deferred<FileHistoryPage>();
    useRepo.setState({ diffLoading: true });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "file_history") return page.promise;
      return Promise.resolve(null);
    });

    const request = useRepo.getState().openFileHistory("src/a.ts");
    expect(useRepo.getState().diffLoading).toBe(false);

    page.resolve({ ...historyPage, entries: [] });
    await request;
    expect(useRepo.getState().diffLoading).toBe(false);
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

  it("keeps the newest same-path history retry when responses finish out of order", async () => {
    const oldPage = deferred<FileHistoryPage>();
    const newPage = deferred<FileHistoryPage>();
    let calls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "file_history") return (calls++ === 0 ? oldPage : newPage).promise;
      if (cmd === "commit_file_diff") return Promise.resolve(fileDiff);
      return Promise.resolve(null);
    });

    const oldRequest = useRepo.getState().openFileHistory("src/a.ts");
    const newRequest = useRepo.getState().openFileHistory("src/a.ts");
    newPage.resolve(pageFor("bbbbbbbbbbbb", "new snapshot"));
    await newRequest;
    oldPage.resolve(pageFor("aaaaaaaaaaaa", "old snapshot"));
    await oldRequest;

    expect(useRepo.getState().fileHistory?.entries[0]?.subject).toBe("new snapshot");
    expect(useRepo.getState().fileHistory?.selectedOid).toBe("bbbbbbbbbbbb");
  });

  it("drops a stale same-path history rejection after a newer retry succeeds", async () => {
    const oldPage = deferred<FileHistoryPage>();
    const newPage = deferred<FileHistoryPage>();
    let calls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "file_history") return (calls++ === 0 ? oldPage : newPage).promise;
      if (cmd === "commit_file_diff") return Promise.resolve(fileDiff);
      return Promise.resolve(null);
    });

    const oldRequest = useRepo.getState().openFileHistory("src/a.ts");
    const newRequest = useRepo.getState().openFileHistory("src/a.ts");
    newPage.resolve(pageFor("bbbbbbbbbbbb", "new snapshot"));
    await newRequest;
    oldPage.reject(new Error("stale failure"));
    await oldRequest;

    expect(useRepo.getState().fileHistory?.error).toBeNull();
    expect(useRepo.getState().fileHistory?.entries[0]?.subject).toBe("new snapshot");
  });

  it("drops an old same-path response after the published repo session changes", async () => {
    const oldPage = deferred<FileHistoryPage>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "file_history") return oldPage.promise;
      return Promise.resolve(fileDiff);
    });

    const request = useRepo.getState().openFileHistory("src/a.ts");
    beginPublishedRepoSession();
    useRepo.setState({
      summary,
      fileHistory: historyState({ entries: pageFor("bbbbbbbbbbbb", "reopened").entries }),
    });
    oldPage.resolve(pageFor("aaaaaaaaaaaa", "old session"));
    await request;

    expect(useRepo.getState().fileHistory?.entries[0]?.subject).toBe("reopened");
  });

  it("does not append a stale pagination page after the same path is reopened", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "file_history") {
        return Promise.resolve(pageFor("aaaaaaaaaaaa", "initial", "src/a.ts", {
          hasMore: true,
          nextOffset: 1,
        }));
      }
      return Promise.resolve(fileDiff);
    });
    await useRepo.getState().openFileHistory("src/a.ts");

    const oldMore = deferred<FileHistoryPage>();
    const reopened = deferred<FileHistoryPage>();
    invokeMock.mockImplementation((cmd: string, args?: { offset?: number }) => {
      if (cmd === "file_history") return args?.offset === 1 ? oldMore.promise : reopened.promise;
      if (cmd === "commit_file_diff") return Promise.resolve(fileDiff);
      return Promise.resolve(null);
    });
    const pagination = useRepo.getState().loadMoreFileHistory();
    const reopen = useRepo.getState().openFileHistory("src/a.ts");
    reopened.resolve(pageFor("cccccccccccc", "reopened"));
    await reopen;
    oldMore.resolve(pageFor("bbbbbbbbbbbb", "stale page"));
    await pagination;

    expect(useRepo.getState().fileHistory?.entries.map((entry) => entry.subject)).toEqual([
      "reopened",
    ]);
    expect(useRepo.getState().fileHistory?.loadingMore).toBe(false);
  });

  it("keeps the newest full revision diff for the same oid", async () => {
    useRepo.setState({ fileHistory: historyState() });
    const preview = deferred<FileDiff>();
    const full = deferred<FileDiff>();
    let calls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "commit_file_diff") return (calls++ === 0 ? preview : full).promise;
      return Promise.resolve(null);
    });

    const previewRequest = useRepo
      .getState()
      .selectFileHistoryRevision("aaaaaaaaaaaa", "src/a.ts", false);
    const fullRequest = useRepo
      .getState()
      .selectFileHistoryRevision("aaaaaaaaaaaa", "src/a.ts", true);
    full.resolve({ ...fileDiff, add: 22 });
    await fullRequest;
    preview.resolve({ ...fileDiff, add: 11, truncated: true });
    await previewRequest;

    expect(useRepo.getState().fileHistory?.selectedDiff?.add).toBe(22);
    expect(useRepo.getState().fileHistory?.diffError).toBeNull();
  });

  it("drops a stale revision-diff rejection after an A-B-A selection cycle", async () => {
    useRepo.setState({ fileHistory: historyState() });
    const oldA = deferred<FileDiff>();
    const middleB = deferred<FileDiff>();
    const newA = deferred<FileDiff>();
    const requests = [oldA, middleB, newA];
    let calls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "commit_file_diff") return requests[calls++].promise;
      return Promise.resolve(null);
    });

    const first = useRepo.getState().selectFileHistoryRevision("aaaaaaaaaaaa", "src/a.ts");
    const middle = useRepo.getState().selectFileHistoryRevision("bbbbbbbbbbbb", "src/b.ts");
    const last = useRepo.getState().selectFileHistoryRevision("aaaaaaaaaaaa", "src/a.ts");
    newA.resolve({ ...fileDiff, add: 33 });
    await last;
    middleB.reject(new Error("stale B failure"));
    await middle;
    oldA.resolve({ ...fileDiff, add: 11 });
    await first;

    expect(useRepo.getState().fileHistory?.selectedOid).toBe("aaaaaaaaaaaa");
    expect(useRepo.getState().fileHistory?.selectedDiff?.add).toBe(33);
    expect(useRepo.getState().fileHistory?.diffError).toBeNull();
  });

  it("drops a child diff after a same-path published-session reopen", async () => {
    useRepo.setState({ fileHistory: historyState() });
    const oldDiff = deferred<FileDiff>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "commit_file_diff") return oldDiff.promise;
      return Promise.resolve(null);
    });

    const request = useRepo
      .getState()
      .selectFileHistoryRevision("aaaaaaaaaaaa", "src/a.ts");
    beginPublishedRepoSession();
    useRepo.setState({
      summary,
      fileHistory: historyState({ selectedDiff: { ...fileDiff, add: 99 } }),
    });
    oldDiff.resolve({ ...fileDiff, add: 11 });
    await request;

    expect(useRepo.getState().fileHistory?.selectedDiff?.add).toBe(99);
    expect(useRepo.getState().fileHistory?.diffLoading).toBe(false);
  });

  it("keeps the newest blame retry for one revision and historical path", async () => {
    useRepo.setState({ fileHistory: historyState() });
    const oldBlame = deferred<FileBlame>();
    const newBlame = deferred<FileBlame>();
    let calls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "file_blame") return (calls++ === 0 ? oldBlame : newBlame).promise;
      return Promise.resolve(null);
    });

    const oldRequest = useRepo.getState().loadFileBlame("aaaaaaaaaaaa", "old/a.ts");
    const newRequest = useRepo.getState().loadFileBlame("aaaaaaaaaaaa", "new/a.ts");
    const latest = {
      path: "new/a.ts",
      revision: "aaaaaaaaaaaa",
      binary: false,
      truncated: false,
      lines: [],
    };
    newBlame.resolve(latest);
    await newRequest;
    oldBlame.reject(new Error("stale blame failure"));
    await oldRequest;

    expect(useRepo.getState().fileHistory?.blame?.path).toBe("new/a.ts");
    expect(useRepo.getState().fileHistory?.blamePath).toBe("new/a.ts");
    expect(useRepo.getState().fileHistory?.blameError).toBeNull();
  });

  it("starts an explicitly different blame while an older blame is loading", async () => {
    useRepo.setState({
      fileHistory: historyState({
        blameLoading: true,
        blameRevision: "aaaaaaaaaaaa",
        blamePath: "old/a.ts",
      }),
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "file_blame") {
        return Promise.resolve({
          path: "new/b.ts",
          revision: "bbbbbbbbbbbb",
          binary: false,
          truncated: false,
          lines: [],
        });
      }
      return Promise.resolve(null);
    });

    useRepo.getState().setFileHistoryMode("blame", "bbbbbbbbbbbb", "new/b.ts");
    await vi.waitFor(() => {
      expect(useRepo.getState().fileHistory?.blamePath).toBe("new/b.ts");
    });
    expect(invokeMock).toHaveBeenCalledWith("file_blame", {
      path: "/repo",
      file: "new/b.ts",
      revision: "bbbbbbbbbbbb",
      limit: null,
    });
  });

  it("uses the live blame mode when the initial history page finishes", async () => {
    const page = deferred<FileHistoryPage>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "file_history") return page.promise;
      if (cmd === "commit_file_diff") return Promise.resolve(fileDiff);
      if (cmd === "file_blame") {
        return Promise.resolve({
          path: "src/a.ts",
          revision: "aaaaaaaaaaaa",
          binary: false,
          truncated: false,
          lines: [],
        });
      }
      return Promise.resolve(null);
    });

    const request = useRepo.getState().openFileHistory("src/a.ts", "history");
    useRepo.getState().setFileHistoryMode("blame");
    page.resolve(historyPage);
    await request;
    await vi.waitFor(() => {
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === "file_blame")).toBe(true);
    });
    expect(useRepo.getState().fileHistory?.mode).toBe("blame");
  });

  it("does not start blame when the live mode switched back to history", async () => {
    const page = deferred<FileHistoryPage>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "file_history") return page.promise;
      if (cmd === "commit_file_diff") return Promise.resolve(fileDiff);
      if (cmd === "file_blame") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    const request = useRepo.getState().openFileHistory("src/a.ts", "blame");
    useRepo.getState().setFileHistoryMode("history");
    page.resolve(historyPage);
    await request;
    await Promise.resolve();

    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "file_blame")).toBe(false);
    expect(useRepo.getState().fileHistory?.mode).toBe("history");
    expect(useRepo.getState().fileHistory?.blameLoading).toBe(false);
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

  it("keeps the newest same-endpoint compare refresh when results finish out of order", async () => {
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

    const oldResult = deferred<typeof compareResult>();
    const newest = {
      ...compareResult,
      files: [{ path: "src/new.ts", status: "A" as const, add: 4, del: 0, binary: false }],
      add: 4,
    };
    let calls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "compare_refs") {
        calls += 1;
        return calls === 1 ? oldResult.promise : Promise.resolve(newest);
      }
      if (cmd === "compare_file_diff") return Promise.resolve({ ...fileDiff, path: "src/new.ts" });
      return Promise.resolve(null);
    });

    const stale = useRepo.getState().refreshCompare();
    await useRepo.getState().refreshCompare();
    oldResult.resolve(compareResult);
    await stale;

    expect(useRepo.getState().compare?.files).toEqual(newest.files);
    expect(useRepo.getState().compare?.add).toBe(4);
  });

  it("invalidates an older selected diff and reloads equal-stat moving refs", async () => {
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
    await vi.waitFor(() => expect(useRepo.getState().compare?.selectedDiff).toEqual(fileDiff));

    const staleDiff = deferred<typeof fileDiff>();
    const refreshedList = deferred<typeof compareResult>();
    const newestDiff = { ...fileDiff, add: 99 };
    let diffCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "compare_refs") return refreshedList.promise;
      if (cmd === "compare_file_diff") {
        diffCalls += 1;
        return diffCalls === 1 ? staleDiff.promise : Promise.resolve(newestDiff);
      }
      return Promise.resolve(null);
    });

    const oldSelection = useRepo.getState().selectCompareFile("src/a.ts");
    const refresh = useRepo.getState().refreshCompare();
    staleDiff.resolve({ ...fileDiff, add: 50 });
    await oldSelection;
    expect(useRepo.getState().compare?.selectedDiff).toEqual(fileDiff);

    // File stats are byte-identical, but branch names can move; the winning
    // list refresh must still fetch a new selected diff.
    refreshedList.resolve(compareResult);
    await refresh;
    await vi.waitFor(() => expect(useRepo.getState().compare?.selectedDiff).toEqual(newestDiff));
  });
});

describe("repo store — returnToGraph", () => {
  const compareResult = {
    files: [{ path: "src/a.ts", status: "M", add: 2, del: 1, binary: false }],
    add: 2,
    del: 1,
    ahead: 1,
    behind: 0,
  };

  it("clears every route that outranks the history tab and selects it", async () => {
    // Populate all four higher-priority routes at once (a superset of any real
    // state) — the transition must clear each one, or deriveCenterView would
    // still resolve away from "history".
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "file_history") return Promise.resolve(historyPage);
      if (cmd === "commit_file_diff") return Promise.resolve(fileDiff);
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
    await useRepo.getState().openFileHistory("src/a.ts");
    useRepo.setState({
      selectedFile: { path: "src/a.ts", source: "commit" },
    });
    useRepo.setState({ fileView: { path: "src/a.ts", content: null, loading: false, error: null } });
    useUi.setState({
      leftTab: "pulls",
      stackedReview: { oid: "abc123", title: "stacked" },
    });

    useRepo.getState().returnToGraph();

    const repo = useRepo.getState();
    expect(repo.compare).toBeNull();
    expect(repo.fileHistory).toBeNull();
    expect(repo.fileView).toBeNull();
    expect(repo.selectedFile).toBeNull();
    expect(useUi.getState().stackedReview).toBeNull();
    expect(useUi.getState().leftTab).toBe("history");
  });

  it("keeps a working-tree file selection — it doesn't outrank the graph", () => {
    useRepo.setState({ selectedFile: { path: "src/a.ts", source: "staged" } });
    useUi.setState({ leftTab: "changes" });

    useRepo.getState().returnToGraph();

    expect(useRepo.getState().selectedFile).toEqual({ path: "src/a.ts", source: "staged" });
    expect(useUi.getState().leftTab).toBe("history");
  });
});
