// Staging writes: discard, patch staging, folder roll-up, and renames.
//
// Split out of the former src/store/repo.test.ts, which reached 5 122 lines;
// shared data fixtures live in @/test/repoFixtures.

import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary so the store's async actions run headlessly. `vi.mock`
// is hoisted above the import below; `vi.hoisted` makes `invokeMock` exist in time.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { EMPTY_CHANGES, defaultInvoke, deferred, emptyGraph, summary } from "@/test/repoFixtures";
import type {
  RepoSummary,
} from "@/lib/api";

const realRefresh = useRepo.getState().refresh;
beforeEach(() => {
  invokeMock.mockReset();
  // Fire-and-forget IPC (e.g. watch/unwatch on tab open/close) must resolve
  // rather than return `undefined`, and every wrapper now validates its result
  // (GL-57) — so answer each command's schema-valid empty payload (a "" status
  // for writes); tests that care set their own impl.
  invokeMock.mockImplementation(emptyIpcInvoke);
  useRepo.setState({
    summary,
    selectedFile: null,
    fileSelectionRequestId: 0,
    fileDiff: null,
    selectedCommit: null,
    inspectParentIndex: 0,
    graphLimit: 2_000,
    loadingMoreHistory: false,
    fetchingPath: null,
    refresh: realRefresh,
  });
});

describe("repo store — discardFile", () => {
  it("re-points the diff at the surviving bucket for a partially-staged file", async () => {
    // The file is staged *and* unstaged; after discarding its unstaged changes
    // it survives in the staged bucket, so the selection should follow it there
    // (rather than leave the pane on a now-empty unstaged diff).
    useRepo.setState({
      changes: {
        staged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
        unstaged: [{ path: "src/a.ts", status: "M", add: 2, del: 0, binary: false }],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
      selectedFile: { path: "src/a.ts", source: "unstaged" },
    });

    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "discard_file":
          return Promise.resolve("Discarded changes in src/a.ts");
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        case "working_changes":
          // The unstaged side is gone; the file remains staged.
          return Promise.resolve({
            staged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
            unstaged: [],
          });
        case "file_diff":
          return Promise.resolve({ path: "src/a.ts", status: "M", binary: false, hunks: [] });
        default:
          // list_branches / list_worktrees / list_stashes / PR fan-out, etc.
          return defaultInvoke(cmd);
      }
    });

    await useRepo
      .getState()
      .discardFile("/repo", "src/a.ts", null, false, "discard-state-v1");

    expect(useRepo.getState().selectedFile).toEqual({ path: "src/a.ts", source: "staged" });
    expect(invokeMock).toHaveBeenCalledWith("discard_file", {
      path: "/repo",
      file: "src/a.ts",
      previousFile: null,
      staged: false,
      expectedState: "discard-state-v1",
    });
  });

  it("drops the selection when the file is fully discarded", async () => {
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [{ path: "src/a.ts", status: "M", add: 2, del: 0, binary: false }],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
      selectedFile: { path: "src/a.ts", source: "unstaged" },
    });

    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "discard_file":
          return Promise.resolve("Discarded changes in src/a.ts");
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        case "working_changes":
          // Nothing left — `refresh` should clear the stale selection.
          return Promise.resolve({ staged: [], unstaged: [] });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo
      .getState()
      .discardFile("/repo", "src/a.ts", null, false, "discard-state-v1");

    expect(useRepo.getState().selectedFile).toBeNull();
  });

  it("does not refresh or reselect another repo when an old discard finishes late", async () => {
    const pending = deferred<string>();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "discard_file" ? pending.promise : defaultInvoke(cmd),
    );
    useRepo.setState({
      summary,
      selectedFile: { path: "src/a.ts", source: "unstaged" },
    });

    const discard = useRepo
      .getState()
      .discardFile("/repo", "src/a.ts", null, false, "discard-state-v1");
    await Promise.resolve();
    const nextSummary: RepoSummary = {
      path: "/other",
      workdir: "/other",
      headBranch: "main",
      headOid: "other-head",
      detached: false,
    };
    useRepo.setState({
      summary: nextSummary,
      selectedFile: { path: "src/b.ts", source: "unstaged" },
    });

    pending.resolve("Discarded changes in src/a.ts");
    await discard;

    expect(useRepo.getState().summary).toEqual(nextSummary);
    expect(useRepo.getState().selectedFile).toEqual({
      path: "src/b.ts",
      source: "unstaged",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("open_repo", expect.anything());
  });

  it("does not publish an old repo's late discard error over the active repo", async () => {
    const pending = deferred<string>();
    const showToast = vi.fn();
    const originalShowToast = useUi.getState().showToast;
    useUi.setState({ showToast });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "discard_file" ? pending.promise : defaultInvoke(cmd),
    );

    try {
      const discard = useRepo
        .getState()
        .discardFile("/repo", "src/a.ts", null, false, "discard-state-v1");
      await Promise.resolve();
      useRepo.setState({
        summary: {
          path: "/other",
          workdir: "/other",
          headBranch: "main",
          headOid: "other-head",
          detached: false,
        },
      });

      pending.reject(new Error("repo A changed"));
      await discard;

      expect(showToast).not.toHaveBeenCalled();
    } finally {
      useUi.setState({ showToast: originalShowToast });
    }
  });
});

describe("repo store — patch staging", () => {
  const refreshInvoke = (cmd: string) => {
    switch (cmd) {
      case "apply_line":
        return Promise.resolve("Staged line in src/a.ts");
      case "open_repo":
        return Promise.resolve(summary);
      case "commit_graph":
        return Promise.resolve(emptyGraph);
      case "working_changes":
        return Promise.resolve(EMPTY_CHANGES);
      default:
        return defaultInvoke(cmd);
    }
  };

  it("does not toast after line-level staging succeeds", async () => {
    const showToast = vi.fn();
    const originalShowToast = useUi.getState().showToast;
    useUi.setState({ showToast });
    invokeMock.mockImplementation(refreshInvoke);

    try {
      await useRepo.getState().applyLine(
        "src/a.ts",
        false,
        0,
        0,
        { kind: "add", oldNo: null, newNo: 1, content: "two" },
      );

      expect(invokeMock).toHaveBeenCalledWith("apply_line", {
        path: "/repo",
        request: {
          file: "src/a.ts",
          staged: false,
          hunkIndex: 0,
          lineIndex: 0,
          expectedKind: "add",
          expectedContent: "two",
          expectedOldNo: undefined,
          expectedNewNo: 1,
        },
      });
      expect(showToast).not.toHaveBeenCalled();
    } finally {
      useUi.setState({ showToast: originalShowToast });
    }
  });
});

describe("repo store — folder roll-up staging", () => {
  // Reads that `refresh()` performs after a write; return valid shapes so the
  // post-action refresh doesn't fail the IPC-shape validation (GL-57).
  const refreshInvoke = (cmd: string) => {
    switch (cmd) {
      case "open_repo":
        return Promise.resolve(summary);
      case "commit_graph":
        return Promise.resolve(emptyGraph);
      case "working_changes":
        return Promise.resolve(EMPTY_CHANGES);
      default:
        return defaultInvoke(cmd);
    }
  };

  it("stagePaths stages the folder's files in one call and refreshes", async () => {
    invokeMock.mockImplementation(refreshInvoke);

    await useRepo.getState().stagePaths(["src/a.ts", "src/b.ts"]);

    expect(invokeMock).toHaveBeenCalledWith("stage_files", {
      path: "/repo",
      files: ["src/a.ts", "src/b.ts"],
    });
    // The single refresh that follows the write.
    expect(invokeMock).toHaveBeenCalledWith("working_changes", expect.anything());
  });

  it("unstagePaths unstages the folder's files in one call", async () => {
    invokeMock.mockImplementation(refreshInvoke);

    await useRepo.getState().unstagePaths(["src/a.ts", "src/b.ts"]);

    expect(invokeMock).toHaveBeenCalledWith("unstage_files", {
      path: "/repo",
      files: ["src/a.ts", "src/b.ts"],
    });
  });

  it("no-ops without a call when the path list is empty", async () => {
    invokeMock.mockImplementation(refreshInvoke);

    await useRepo.getState().stagePaths([]);

    expect(invokeMock).not.toHaveBeenCalledWith("stage_files", expect.anything());
  });

  it("blocks stagePaths when any file is outside the sparse checkout", async () => {
    const showToast = vi.fn();
    const originalShowToast = useUi.getState().showToast;
    useUi.setState({ showToast });
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [{ path: "docs/hidden.txt", status: "M", add: 1, del: 1, binary: false }],
        conflicted: [],
        advanced: {
          submodules: [],
          lfs: { detected: false, installed: null, issues: [], patterns: [] },
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["/*", "!/*/", "/src/"], truncated: false },
        },
      },
    });
    invokeMock.mockImplementation(refreshInvoke);

    try {
      await useRepo.getState().stagePaths(["docs/hidden.txt"]);

      expect(invokeMock).not.toHaveBeenCalledWith("stage_files", expect.anything());
      expect(showToast).toHaveBeenCalledWith(
        "Outside sparse checkout. Expand the sparse checkout or use git add --sparse.",
        "error",
      );
    } finally {
      useUi.setState({ showToast: originalShowToast });
    }
  });

  it("unstagePaths no-ops without a call when the path list is empty", async () => {
    invokeMock.mockImplementation(refreshInvoke);

    await useRepo.getState().unstagePaths([]);

    expect(invokeMock).not.toHaveBeenCalledWith("unstage_files", expect.anything());
  });

  it("blocks unstagePaths when a staged file is outside the sparse checkout", async () => {
    const showToast = vi.fn();
    const originalShowToast = useUi.getState().showToast;
    useUi.setState({ showToast });
    useRepo.setState({
      changes: {
        staged: [{ path: "docs/hidden.txt", status: "M", add: 1, del: 1, binary: false }],
        unstaged: [],
        conflicted: [],
        advanced: {
          submodules: [],
          lfs: { detected: false, installed: null, issues: [], patterns: [] },
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["/*", "!/*/", "/src/"], truncated: false },
        },
      },
    });
    invokeMock.mockImplementation(refreshInvoke);

    try {
      await useRepo.getState().unstagePaths(["docs/hidden.txt"]);

      expect(invokeMock).not.toHaveBeenCalledWith("unstage_files", expect.anything());
      expect(showToast).toHaveBeenCalledWith(
        "Outside sparse checkout. Expand the sparse checkout or use git add --sparse.",
        "error",
      );
    } finally {
      useUi.setState({ showToast: originalShowToast });
    }
  });
});

describe("repo store — rename staging (GL-127)", () => {
  // Reads that `refresh()` performs after a write; valid shapes so the
  // post-action refresh passes IPC-shape validation (GL-57).
  const refreshInvoke = (cmd: string) => {
    switch (cmd) {
      case "open_repo":
        return Promise.resolve(summary);
      case "commit_graph":
        return Promise.resolve(emptyGraph);
      case "working_changes":
        return Promise.resolve(EMPTY_CHANGES);
      case "file_diff":
        return Promise.resolve({ path: "new.txt", status: "R", binary: false, hunks: [] });
      default:
        return defaultInvoke(cmd);
    }
  };

  it("stages both sides of an unstaged rename in one atomic call", async () => {
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [
          { path: "new.txt", status: "R", add: 0, del: 0, binary: false, previousPath: "old.txt" },
        ],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
    });
    invokeMock.mockImplementation(refreshInvoke);

    await useRepo.getState().stageFile("new.txt");

    expect(invokeMock).toHaveBeenCalledWith("stage_files", {
      path: "/repo",
      files: ["old.txt", "new.txt"],
    });
  });

  it("unstages both sides of a staged rename in one atomic call", async () => {
    useRepo.setState({
      changes: {
        staged: [
          { path: "new.txt", status: "R", add: 0, del: 0, binary: false, previousPath: "old.txt" },
        ],
        unstaged: [],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
    });
    invokeMock.mockImplementation(refreshInvoke);

    await useRepo.getState().unstageFile("new.txt");

    expect(invokeMock).toHaveBeenCalledWith("unstage_files", {
      path: "/repo",
      files: ["old.txt", "new.txt"],
    });
  });

  it("stages an ordinary (non-rename) file as a one-path batch", async () => {
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
    });
    invokeMock.mockImplementation(refreshInvoke);

    await useRepo.getState().stageFile("src/a.ts");

    expect(invokeMock).toHaveBeenCalledWith("stage_files", { path: "/repo", files: ["src/a.ts"] });
  });

  it("folder roll-up (stagePaths) pulls in a rename's old path so it isn't half-staged", async () => {
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [
          { path: "src/b.ts", status: "M", add: 1, del: 0, binary: false },
          { path: "src/new.ts", status: "R", add: 0, del: 0, binary: false, previousPath: "src/old.ts" },
        ],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
    });
    invokeMock.mockImplementation(refreshInvoke);

    // The Tree view rolls up the directory's *displayed* (new-side) paths.
    await useRepo.getState().stagePaths(["src/b.ts", "src/new.ts"]);

    // The rename's old side is expanded in, so the folder stages as one rename.
    expect(invokeMock).toHaveBeenCalledWith("stage_files", {
      path: "/repo",
      files: ["src/b.ts", "src/new.ts", "src/old.ts"],
    });
  });

  it("folder roll-up (unstagePaths) pulls in a staged rename's old path", async () => {
    useRepo.setState({
      changes: {
        staged: [
          { path: "src/new.ts", status: "R", add: 0, del: 0, binary: false, previousPath: "src/old.ts" },
        ],
        unstaged: [],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
    });
    invokeMock.mockImplementation(refreshInvoke);

    await useRepo.getState().unstagePaths(["src/new.ts"]);

    expect(invokeMock).toHaveBeenCalledWith("unstage_files", {
      path: "/repo",
      files: ["src/new.ts", "src/old.ts"],
    });
  });

  it("commits the complete staged set and reports success", async () => {
    useRepo.setState({
      changes: {
        staged: [
          { path: "keep.ts", status: "M", add: 1, del: 0, binary: false },
          { path: "src/new.ts", status: "R", add: 0, del: 0, binary: false, previousPath: "src/old.ts" },
        ],
        unstaged: [],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
    });
    invokeMock.mockImplementation(refreshInvoke);

    const committed = await useRepo.getState().commitSelected("Subject", false);

    expect(committed).toBe(true);
    expect(invokeMock).not.toHaveBeenCalledWith("unstage_files", expect.anything());
    expect(invokeMock).toHaveBeenCalledWith("commit", expect.objectContaining({ path: "/repo" }));
  });
});
