import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary so the store's async actions run headlessly. `vi.mock`
// is hoisted above the import below; `vi.hoisted` makes `invokeMock` exist in time.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { SESSION_RESTORE_PHASE, useRepo } from "./repo";
import { initialSessionRestorePhase } from "./repoTypes";
import type { OperationState } from "./repo";
import { usePulls } from "./pulls";
import { useUi } from "./ui";
import { ForgeKind } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import type { PullRequest } from "@/lib/prs";
import type {
  BranchInfo,
  CommitNode,
  RepoForge,
  RepoGraph,
  RepoSummary,
  StashEntry,
  WorkingChanges,
  WorktreeInfo,
} from "@/lib/api";

// A minimal summary so actions that require an open repo proceed.
const summary: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: null,
  detached: false,
};
const emptyGraph: RepoGraph = {
  commits: [],
  edges: [],
  laneCount: 1,
  head: null,
  truncated: false,
};

// Default invoke result for any command a test doesn't mock explicitly. Most
// reads return a list, but `working_changes` is a WorkingChanges object — now
// that lib/api validates the IPC shape (GL-57), a catch-all `[]` is rejected at
// the seam, so route the fall-through through here.
const EMPTY_CHANGES: WorkingChanges = { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState };
const defaultInvoke = (cmd: string) =>
  Promise.resolve(cmd === "working_changes" ? EMPTY_CHANGES : []);

// Build a complete CommitNode for graph fixtures. lib/api now validates the
// commit_graph shape (GL-57), so a partial inline node is rejected at the seam.
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
  color: 0,
  refs: [],
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
  // Fire-and-forget IPC (e.g. watch/unwatch on tab open/close) must resolve
  // rather than return `undefined`; tests that care set their own impl.
  invokeMock.mockResolvedValue(undefined);
  useRepo.setState({
    summary,
    selectedFile: null,
    fileSelectionRequestId: 0,
    fileDiff: null,
    selectedCommit: null,
    graphLimit: 2_000,
    loadingMoreHistory: false,
    fetchingPath: null,
  });
});

describe("repo store — ensureWorkingFileSelection", () => {
  const change = (path: string) => ({
    path,
    status: "M" as const,
    add: 1,
    del: 0,
    binary: false,
  });
  const diff = (path: string) => ({
    ...change(path),
    hunks: [],
    truncated: false,
  });

  it("selects the first live working file when no working selection exists", async () => {
    useRepo.setState({
      changes: {
        staged: [change("staged.ts")],
        unstaged: [change("unstaged.ts")],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "file_diff" ? Promise.resolve(diff("unstaged.ts")) : defaultInvoke(cmd),
    );

    useRepo.getState().ensureWorkingFileSelection();

    await vi.waitFor(() =>
      expect(useRepo.getState().selectedFile).toEqual({ path: "unstaged.ts", source: "unstaged" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("file_diff", {
      path: "/repo",
      file: "unstaged.ts",
      staged: false,
      full: null,
    });
  });

  it("keeps the path but changes source when staging moves the selected file", async () => {
    useRepo.setState({
      changes: {
        staged: [change("src/a.ts")],
        unstaged: [],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
      selectedFile: { path: "src/a.ts", source: "unstaged" },
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "file_diff" ? Promise.resolve(diff("src/a.ts")) : defaultInvoke(cmd),
    );

    useRepo.getState().ensureWorkingFileSelection();

    await vi.waitFor(() =>
      expect(useRepo.getState().selectedFile).toEqual({ path: "src/a.ts", source: "staged" }),
    );
    expect(invokeMock).toHaveBeenCalledWith("file_diff", {
      path: "/repo",
      file: "src/a.ts",
      staged: true,
      full: null,
    });
  });

  it("does not reload a selection that is still in its owning bucket", () => {
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [change("src/a.ts")],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
      selectedFile: { path: "src/a.ts", source: "unstaged" },
    });

    useRepo.getState().ensureWorkingFileSelection();

    expect(invokeMock).not.toHaveBeenCalled();
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

    await useRepo.getState().discardFile("src/a.ts", false);

    expect(useRepo.getState().selectedFile).toEqual({ path: "src/a.ts", source: "staged" });
    expect(invokeMock).toHaveBeenCalledWith("discard_file", {
      path: "/repo",
      file: "src/a.ts",
      staged: false,
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

    await useRepo.getState().discardFile("src/a.ts", false);

    expect(useRepo.getState().selectedFile).toBeNull();
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
        file: "src/a.ts",
        staged: false,
        hunkIndex: 0,
        lineIndex: 0,
        expectedKind: "add",
        expectedContent: "two",
        expectedOldNo: null,
        expectedNewNo: 1,
      });
      expect(showToast).not.toHaveBeenCalled();
    } finally {
      useUi.setState({ showToast: originalShowToast });
    }
  });
});

describe("repo store — advanced write guards", () => {
  it("blocks stageFile for a visible path outside sparse checkout", async () => {
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
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["/*", "!/*/", "/src/"] },
        },
      },
    });

    try {
      await useRepo.getState().stageFile("docs/hidden.txt");

      expect(invokeMock).not.toHaveBeenCalledWith("stage_file", expect.anything());
      expect(showToast).toHaveBeenCalledWith(
        "Outside sparse checkout. Expand the sparse checkout or use git add --sparse.",
        "error",
      );
    } finally {
      useUi.setState({ showToast: originalShowToast });
    }
  });

  it("blocks patch-level staging for a guarded sparse path", async () => {
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
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["/*", "!/*/", "/src/"] },
        },
      },
    });

    try {
      await useRepo.getState().applyHunk("docs/hidden.txt", false, 0, "@@ -1 +1 @@", "-one\n+two");
      await useRepo.getState().applyLine(
        "docs/hidden.txt",
        false,
        0,
        0,
        { kind: "add", oldNo: null, newNo: 1, content: "two" },
      );

      expect(invokeMock).not.toHaveBeenCalledWith("apply_hunk", expect.anything());
      expect(invokeMock).not.toHaveBeenCalledWith("apply_line", expect.anything());
      expect(showToast).toHaveBeenCalledWith(
        "Outside sparse checkout. Expand the sparse checkout or use git add --sparse.",
        "error",
      );
      expect(showToast).toHaveBeenCalledTimes(2);
    } finally {
      useUi.setState({ showToast: originalShowToast });
    }
  });

  it("allows stash when sparse checkout is only informational", async () => {
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [{ path: "src/visible.txt", status: "M", add: 1, del: 0, binary: false }],
        conflicted: [],
        advanced: {
          submodules: [],
          lfs: { detected: false, installed: null, issues: [], patterns: [] },
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["src/"] },
        },
      },
    });
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "stash":
          return Promise.resolve("Saved working directory");
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().stash();

    expect(invokeMock).toHaveBeenCalledWith("stash", {
      path: "/repo",
      expectedBranch: "main",
      expectedOid: null,
    });
  });

  it("blocks stash when a dirty submodule row is present", async () => {
    const showToast = vi.fn();
    const originalShowToast = useUi.getState().showToast;
    useUi.setState({ showToast });
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [
          {
            path: "deps/child",
            status: "M",
            add: 0,
            del: 0,
            binary: false,
            advanced: { kind: "submodule", message: "Submodule: modified files inside submodule" },
          },
        ],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
    });

    try {
      await useRepo.getState().stash();

      expect(invokeMock).not.toHaveBeenCalledWith("stash", expect.anything());
      expect(showToast).toHaveBeenCalledWith(
        "Submodule: modified files inside submodule. Use the terminal for submodule updates.",
        "error",
      );
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
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["/*", "!/*/", "/src/"] },
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
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["/*", "!/*/", "/src/"] },
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

    // Both paths go through the multi-path command; the single-path one is not used.
    expect(invokeMock).toHaveBeenCalledWith("stage_files", {
      path: "/repo",
      files: ["old.txt", "new.txt"],
    });
    expect(invokeMock).not.toHaveBeenCalledWith("stage_file", expect.anything());
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
    expect(invokeMock).not.toHaveBeenCalledWith("unstage_file", expect.anything());
  });

  it("leaves an ordinary (non-rename) file on the single-path stage command", async () => {
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

    expect(invokeMock).toHaveBeenCalledWith("stage_file", { path: "/repo", file: "src/a.ts" });
    expect(invokeMock).not.toHaveBeenCalledWith("stage_files", expect.anything());
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

describe("repo store — mergeInto toast mapping", () => {
  // `merge --no-ff` exits 0 without creating anything when the branch is
  // already reachable from HEAD (equal tips included) — the returned message
  // must say so instead of claiming a merge happened. The backend pins the
  // subprocess to LC_ALL=C, so the "Already up to date." match is stable.
  const invokeWithMergeOutput = (output: string) => (cmd: string) => {
    switch (cmd) {
      case "merge_branch":
        return Promise.resolve(output);
      case "open_repo":
        return Promise.resolve(summary);
      case "commit_graph":
        return Promise.resolve(emptyGraph);
      default:
        return defaultInvoke(cmd);
    }
  };

  beforeEach(() => {
    useRepo.setState({
      summary: { ...summary, headOid: "1111111" },
      branches: [
        { name: "main", kind: "local", target: "1111111", isHead: true, upstream: null, remote: null },
        { name: "feature", kind: "local", target: "2222222", isHead: false, upstream: null, remote: null },
      ],
    });
  });

  it("reports the merge when git created a merge commit", async () => {
    invokeMock.mockImplementation(
      invokeWithMergeOutput("Merge made by the 'ort' strategy.\n file.txt | 1 +"),
    );

    const msg = await useRepo.getState().mergeInto("feature", "main");

    expect(invokeMock).toHaveBeenCalledWith("merge_branch", {
      path: "/repo",
      source: "refs/heads/feature",
      expectedSourceOid: "2222222",
      destination: "main",
      expectedDestinationOid: "1111111",
    });
    expect(msg).toBe("Merged feature into main");
  });

  it("reports up-to-date when the no-ff merge was a no-op", async () => {
    invokeMock.mockImplementation(invokeWithMergeOutput("Already up to date."));

    const msg = await useRepo.getState().mergeInto("feature", "main");

    expect(msg).toBe("main is already up to date with feature");
  });

  it("merges into a detached HEAD without looking for a local branch named HEAD", async () => {
    useRepo.setState({
      summary: { ...summary, headBranch: null, headOid: "1111111", detached: true },
      branches: [
        { name: "feature", kind: "local", target: "2222222", isHead: false, upstream: null, remote: null },
      ],
    });
    invokeMock.mockImplementation(
      invokeWithMergeOutput("Merge made by the 'ort' strategy."),
    );

    await useRepo.getState().mergeInto("feature", "HEAD");

    expect(invokeMock).toHaveBeenCalledWith("merge_branch", {
      path: "/repo",
      source: "refs/heads/feature",
      expectedSourceOid: "2222222",
      destination: null,
      expectedDestinationOid: "1111111",
    });
  });
});

describe("repo store — captured write subjects", () => {
  beforeEach(() => {
    useRepo.setState({
      summary: { ...summary, headOid: "1111111" },
      branches: [
        { name: "main", kind: "local", target: "1111111", isHead: true, upstream: null, remote: null },
        { name: "feature", kind: "local", target: "2222222", isHead: false, upstream: null, remote: null },
      ],
    });
  });

  it("creates a branch at the captured start ref pinned to its oid", async () => {
    await useRepo.getState().createBranchAt("new-branch", "feature");

    expect(invokeMock).toHaveBeenCalledWith("create_branch", {
      path: "/repo",
      name: "new-branch",
      startPoint: "refs/heads/feature",
      expectedOid: "2222222",
    });
  });

  it("keeps a remote-tracking start point as a ref so upstream setup survives", async () => {
    useRepo.setState({
      branches: [
        { name: "origin/topic", kind: "remote", target: "3333333", isHead: false, upstream: null, remote: "origin" },
      ],
    });

    await useRepo.getState().createBranchAt("topic", "origin/topic");

    expect(invokeMock).toHaveBeenCalledWith("create_branch", {
      path: "/repo",
      name: "topic",
      startPoint: "refs/remotes/origin/topic",
      expectedOid: "3333333",
    });
  });

  it("fails closed when local and remote refs have the same display name", async () => {
    useRepo.setState({
      branches: [
        { name: "origin/main", kind: "local", target: "1111111", isHead: false, upstream: null, remote: null },
        { name: "origin/main", kind: "remote", target: "2222222", isHead: false, upstream: null, remote: "origin" },
      ],
    });

    await expect(useRepo.getState().createBranchAt("new-branch", "origin/main"))
      .rejects.toThrow("Cannot resolve ambiguous ref origin/main");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("applies a stash only to the captured HEAD", async () => {
    await useRepo.getState().applyStash("abcdef1", false);

    expect(invokeMock).toHaveBeenCalledWith("stash_apply", {
      path: "/repo",
      expectedBranch: "main",
      expectedOid: "1111111",
      oid: "abcdef1",
    });
  });

  it("creates an implicit-HEAD tag at the captured oid", async () => {
    await useRepo.getState().createTagAt("v-next");

    expect(invokeMock).toHaveBeenCalledWith("create_tag", {
      path: "/repo",
      name: "v-next",
      sha: "1111111",
    });
  });
});

describe("repo store — large history", () => {
  it("loads the next graph page and preserves the larger limit", async () => {
    useRepo.setState({
      graph: {
        commits: [],
        edges: [],
        laneCount: 1,
        head: null,
        truncated: true,
      },
      selectedCommit: "selected",
      selectedCommits: ["selected"],
    });
    invokeMock.mockResolvedValueOnce({
      commits: [node({ id: "selected" })],
      edges: [],
      laneCount: 1,
      head: "selected",
      truncated: false,
    });

    await useRepo.getState().loadMoreHistory();

    expect(invokeMock).toHaveBeenCalledWith("commit_graph", {
      path: "/repo",
      limit: 4_000,
    });
    expect(useRepo.getState().graphLimit).toBe(4_000);
    expect(useRepo.getState().selectedCommit).toBe("selected");
    expect(useRepo.getState().loadingMoreHistory).toBe(false);
  });

  it("uses a worktree-only watcher refresh without rebuilding the graph", async () => {
    const graph = {
      commits: [],
      edges: [],
      laneCount: 1,
      head: null,
      truncated: false,
    };
    useRepo.setState({ graph });
    // A worktree refresh reads working changes + operation status, but never
    // rebuilds the graph.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      if (cmd === "operation_status")
        return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
      return defaultInvoke(cmd);
    });

    await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });

    expect(invokeMock).toHaveBeenCalledWith("working_changes", { path: "/repo" });
    expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());
    expect(useRepo.getState().graph).toBe(graph);
  });

  it("sets and clears operationAdvisory from operation_status (git am / bisect)", async () => {
    const status = (advisory: string) =>
      Promise.resolve({ kind: "none", canSkip: false, conflicts: [], advisory });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [], conflicted: [] });
      if (cmd === "operation_status") return status("bisect");
      return defaultInvoke(cmd);
    });
    await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
    expect(useRepo.getState().operationAdvisory).toBe("bisect");

    // A subsequent clean status (empty advisory) clears it.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [], conflicted: [] });
      if (cmd === "operation_status") return status("");
      return defaultInvoke(cmd);
    });
    await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
    expect(useRepo.getState().operationAdvisory).toBeNull();
  });

  it("clears a WIP selection when a worktree refresh becomes clean", async () => {
    useRepo.setState({ wipSelected: true });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      if (cmd === "operation_status")
        return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
      return defaultInvoke(cmd);
    });

    await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });

    expect(useRepo.getState().wipSelected).toBe(false);
  });

  // GL-123: the watcher refresh must also reconcile the diff of the file open in
  // the viewer (`fileDiff`), so an external edit lands live instead of staying
  // stale until re-click.
  describe("open-diff reconcile", () => {
    // A minimal schema-valid FileDiff (lib/api validates the file_diff shape).
    const diff = (over: Partial<import("@/lib/api").FileDiff> = {}) => ({
      path: "src/a.ts",
      status: "M" as const,
      add: 1,
      del: 0,
      binary: false,
      hunks: [],
      truncated: false,
      ...over,
    });

    it("refetches the open unstaged file's diff on a worktree refresh", async () => {
      const oldDiff = diff({ add: 0 });
      const newDiff = diff({ add: 9 });
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: oldDiff,
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 9, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return Promise.resolve(newDiff);
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      // The reconcile is fire-and-forget — flush the microtask queue before asserting.
      await vi.waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("file_diff", {
          path: "/repo",
          file: "src/a.ts",
          staged: false,
          full: true,
        }),
      );
      expect(useRepo.getState().fileDiff).toEqual(newDiff);
    });

    it("never flips diffLoading while reconciling", async () => {
      const slow = deferred<ReturnType<typeof diff>>();
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff(),
        diffLoading: false,
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return slow.promise;
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      // With the file_diff still pending, the reconcile must not have raised the spinner.
      expect(useRepo.getState().diffLoading).toBe(false);
      slow.resolve(diff({ add: 3 }));
      await vi.waitFor(() => expect(useRepo.getState().fileDiff?.add).toBe(3));
      expect(useRepo.getState().diffLoading).toBe(false);
    });

    it("refetches full when the shown diff is not truncated, capped when it is", async () => {
      const base = {
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState } as WorkingChanges,
        selectedFile: { path: "src/a.ts", source: "unstaged" as const },
      };
      const worktreeInvoke = (cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return Promise.resolve(diff());
        return defaultInvoke(cmd);
      };

      useRepo.setState({ ...base, fileDiff: diff({ truncated: false }) });
      invokeMock.mockImplementation(worktreeInvoke);
      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      await vi.waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("file_diff", expect.objectContaining({ full: true })),
      );

      invokeMock.mockReset();
      useRepo.setState({ ...base, fileDiff: diff({ truncated: true }) });
      invokeMock.mockImplementation(worktreeInvoke);
      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      await vi.waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("file_diff", expect.objectContaining({ full: false })),
      );
    });

    it("never refetches for a commit-source selection", async () => {
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "commit" },
        fileDiff: diff(),
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      await Promise.resolve();
      expect(invokeMock).not.toHaveBeenCalledWith("file_diff", expect.anything());
    });

    it("clears the selection and skips the refetch when the open file vanished", async () => {
      useRepo.setState({
        changes: {
          staged: [],
          unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          conflicted: [],
          advanced: emptyAdvancedState,
        },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff(),
      });
      invokeMock.mockImplementation((cmd: string) => {
        // The file is gone from both buckets — committed/discarded outside the app.
        if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      await Promise.resolve();
      expect(useRepo.getState().selectedFile).toBeNull();
      expect(useRepo.getState().fileDiff).toBeNull();
      expect(invokeMock).not.toHaveBeenCalledWith("file_diff", expect.anything());
    });

    it("reconciles the open diff on an all-scope refresh too", async () => {
      const newDiff = diff({ add: 7 });
      useRepo.setState({
        graph: emptyGraph,
        selectedCommit: null,
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff({ add: 0 }),
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "open_repo") return Promise.resolve(summary);
        if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 7, del: 0, binary: false }],
          });
        if (cmd === "file_diff") return Promise.resolve(newDiff);
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false });
      await vi.waitFor(() => expect(useRepo.getState().fileDiff).toEqual(newDiff));
      expect(invokeMock).toHaveBeenCalledWith(
        "file_diff",
        expect.objectContaining({ path: "/repo", file: "src/a.ts", staged: false }),
      );
    });

    it("a stale reconcile cannot clobber a newer selection", async () => {
      const slow = deferred<ReturnType<typeof diff>>();
      const newerDiff = diff({ path: "src/b.ts", add: 5 });
      useRepo.setState({
        changes: {
          staged: [],
          unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          conflicted: [],
          advanced: emptyAdvancedState,
        },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff(),
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return slow.promise;
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      // Before the in-flight reconcile resolves, the user selects another file.
      useRepo.setState({
        selectedFile: { path: "src/b.ts", source: "unstaged" },
        fileDiff: newerDiff,
      });
      slow.resolve(diff({ path: "src/a.ts", add: 99 }));
      await slow.promise;
      await Promise.resolve();
      expect(useRepo.getState().fileDiff).toEqual(newerDiff);
    });

    it("a capped reconcile cannot downgrade a diff expanded while it was in flight", async () => {
      const slow = deferred<ReturnType<typeof diff>>();
      const expanded = diff({ truncated: false, add: 4 });
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        // The shown diff is truncated, so the reconcile fetches capped.
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff({ truncated: true }),
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return slow.promise;
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      // "Show full" lands while the capped reconcile is still in flight.
      useRepo.setState({ fileDiff: expanded });
      slow.resolve(diff({ truncated: true, add: 2 }));
      await slow.promise;
      await Promise.resolve();
      expect(useRepo.getState().fileDiff).toEqual(expanded);
    });

    it("fetches the staged diff for a staged selection", async () => {
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "staged" },
        fileDiff: diff(),
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
            unstaged: [],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return Promise.resolve(diff({ add: 2 }));
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      await vi.waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("file_diff", expect.objectContaining({ staged: true })),
      );
      expect(useRepo.getState().fileDiff?.add).toBe(2);
    });

    it("a stale reconcile cannot leak an unstaged diff into a staged selection of the same path", async () => {
      const slow = deferred<ReturnType<typeof diff>>();
      const stagedDiff = diff({ add: 5 });
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff(),
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [{ path: "src/a.ts", status: "M", add: 5, del: 0, binary: false }],
            unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return slow.promise;
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      // Same path, other bucket: the user clicks the staged row mid-reconcile.
      useRepo.setState({
        selectedFile: { path: "src/a.ts", source: "staged" },
        fileDiff: stagedDiff,
      });
      slow.resolve(diff({ add: 99 }));
      await slow.promise;
      await Promise.resolve();
      expect(useRepo.getState().fileDiff).toEqual(stagedDiff);
    });

    it("out-of-order reconciles resolve newest-wins for the same file", async () => {
      const slow = deferred<ReturnType<typeof diff>>();
      const newDiff = diff({ add: 8 });
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff({ add: 0 }),
      });
      let diffCalls = 0;
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 8, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        // The first tick's fetch stalls; the second tick's resolves immediately.
        if (cmd === "file_diff") return ++diffCalls === 1 ? slow.promise : Promise.resolve(newDiff);
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      await vi.waitFor(() => expect(useRepo.getState().fileDiff).toEqual(newDiff));
      // The older response lands last but must not publish over the newer one.
      slow.resolve(diff({ add: 99 }));
      await slow.promise;
      await Promise.resolve();
      expect(useRepo.getState().fileDiff).toEqual(newDiff);
    });

    it("skips publishing while a foreground diff load is in flight", async () => {
      const slow = deferred<ReturnType<typeof diff>>();
      const shown = diff({ add: 1 });
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: shown,
        diffLoading: false,
      });
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return slow.promise;
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      // A selectFile/loadFullFileDiff raised the spinner mid-reconcile: it owns
      // the pane and will land fresher content, so the reconcile must not publish.
      useRepo.setState({ diffLoading: true });
      slow.resolve(diff({ add: 42 }));
      await slow.promise;
      await Promise.resolve();
      expect(useRepo.getState().fileDiff).toEqual(shown);
    });

    it("a stale reconcile cannot overwrite a completed foreground re-select of the same file", async () => {
      const slow = deferred<ReturnType<typeof diff>>();
      const foreground = diff({ add: 6 });
      useRepo.setState({
        changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff(),
        diffLoading: false,
      });
      let diffCalls = 0;
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "src/a.ts", status: "M", add: 6, del: 0, binary: false }],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        // The reconcile's fetch stalls; the user's re-click resolves immediately.
        if (cmd === "file_diff") return ++diffCalls === 1 ? slow.promise : Promise.resolve(foreground);
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      // The user re-clicks the same row; selectFile completes (diffLoading back
      // to false) before the reconcile's slower response lands.
      const requestId = useRepo.getState().fileSelectionRequestId;
      await useRepo.getState().selectFile("src/a.ts", "unstaged");
      expect(useRepo.getState().fileDiff).toEqual(foreground);
      expect(useRepo.getState().fileSelectionRequestId).toBe(requestId + 1);
      slow.resolve(diff({ add: 99 }));
      await slow.promise;
      await Promise.resolve();
      expect(useRepo.getState().fileDiff).toEqual(foreground);
    });

    it("keeps the selection source when the file moved buckets, showing its (empty) diff", async () => {
      const emptyDiff = diff({ add: 0, del: 0 });
      useRepo.setState({
        changes: {
          staged: [],
          unstaged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
          conflicted: [],
          advanced: emptyAdvancedState,
        },
        selectedFile: { path: "src/a.ts", source: "unstaged" },
        fileDiff: diff(),
        diffLoading: false,
      });
      invokeMock.mockImplementation((cmd: string) => {
        // The file was fully staged outside the app: present in staged only.
        if (cmd === "working_changes")
          return Promise.resolve({
            staged: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
            unstaged: [],
          });
        if (cmd === "operation_status")
          return Promise.resolve({ kind: "none", canSkip: false, conflicts: [] });
        if (cmd === "file_diff") return Promise.resolve(emptyDiff);
        return defaultInvoke(cmd);
      });

      await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });
      // The selection stays unstaged-sourced (no silent retarget), so the
      // reconcile fetches the now-empty unstaged diff rather than the staged one.
      await vi.waitFor(() => expect(useRepo.getState().fileDiff).toEqual(emptyDiff));
      expect(invokeMock).toHaveBeenCalledWith("file_diff", expect.objectContaining({ staged: false }));
      expect(useRepo.getState().selectedFile).toEqual({ path: "src/a.ts", source: "unstaged" });
    });
  });

  it("ignores a stale load-more result after a newer full refresh", async () => {
    const slowLoadMore = deferred<typeof emptyGraph>();
    const refreshedGraph = { ...emptyGraph, head: "fresh" };
    let graphCalls = 0;
    useRepo.setState({
      graph: { ...emptyGraph, truncated: true },
      selectedCommit: null,
      selectedCommits: [],
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "commit_graph") {
        graphCalls += 1;
        return graphCalls === 1 ? slowLoadMore.promise : Promise.resolve(refreshedGraph);
      }
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return defaultInvoke(cmd);
    });

    const loadMore = useRepo.getState().loadMoreHistory();
    await useRepo.getState().refresh({ prs: false, quiet: true });
    slowLoadMore.resolve({ ...emptyGraph, head: "stale" });
    await loadMore;

    // commitGraph returns a validated copy (GL-57), so compare by value.
    expect(useRepo.getState().graph).toEqual(refreshedGraph);
    expect(useRepo.getState().graphLimit).toBe(2_000);
    expect(useRepo.getState().loadingMoreHistory).toBe(false);
  });

  it("ignores a load-more result after switching repositories", async () => {
    const slowLoadMore = deferred<typeof emptyGraph>();
    useRepo.setState({ graph: { ...emptyGraph, truncated: true } });
    invokeMock.mockReturnValueOnce(slowLoadMore.promise);

    const loadMore = useRepo.getState().loadMoreHistory();
    useRepo.setState({
      summary: { ...summary, path: "/other" },
      graph: { ...emptyGraph, head: "other" },
      loadingMoreHistory: false,
    });
    slowLoadMore.resolve({ ...emptyGraph, head: "stale" });
    await loadMore;

    expect(useRepo.getState().graph?.head).toBe("other");
  });

  it("clears the active repo state if switching after close cannot load", async () => {
    useRepo.setState({
      summary,
      openPaths: ["/repo", "/other"],
      graph: emptyGraph,
    });
    // Target the neighbour's open specifically: closeRepo now also fires a
    // fire-and-forget unwatch, so a bare `…Once` would be consumed by that.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo"
        ? Promise.reject(new Error("cannot open"))
        : defaultInvoke(cmd),
    );

    await useRepo.getState().closeRepo("/repo");

    expect(useRepo.getState().openPaths).toEqual(["/other"]);
    expect(useRepo.getState().summary).toBeNull();
    expect(useRepo.getState().graph).toBeNull();
    expect(useRepo.getState().graphLimit).toBe(2_000);
    expect(useRepo.getState().error).toContain("cannot open");
  });
});

// The hand-off dialog is repo-bound like confirm/prompt/recovery, so a repo
// switch must clear it — EXCEPT the switch the hand-off itself performs when
// it lands on the destination (flagged via `handoffRunning`), which is about
// to show the success screen (GL-105).
describe("repo store — hand-off overlay lifecycle", () => {
  const openHandoffDialog = () =>
    useUi.setState({
      handoff: { branch: "feature", sourcePath: "/repo-feature", sourceChanges: 1 },
      handoffRunning: false,
    });
  const switchInvoke = (path: string) => (cmd: string) => {
    if (cmd === "open_repo") return Promise.resolve({ ...summary, path, workdir: path });
    if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
    return defaultInvoke(cmd);
  };

  it("closes a stale hand-off dialog on a genuine repo switch", async () => {
    openHandoffDialog();
    invokeMock.mockImplementation(switchInvoke("/other"));
    await useRepo.getState().loadRepo("/other");
    expect(useUi.getState().handoff).toBeNull();
  });

  it("keeps the dialog through the hand-off's own destination load", async () => {
    openHandoffDialog();
    useUi.setState({ handoffRunning: true });
    invokeMock.mockImplementation(switchInvoke("/dest"));
    await useRepo.getState().loadRepo("/dest");
    expect(useUi.getState().handoff).not.toBeNull();
    useUi.setState({ handoff: null, handoffRunning: false });
  });

  it("closes the dialog when the last tab closes", async () => {
    openHandoffDialog();
    useRepo.setState({ summary, openPaths: ["/repo"] });
    await useRepo.getState().closeRepo("/repo");
    expect(useUi.getState().handoff).toBeNull();
  });

  // A dismissed dialog leaves the move running in the background; if the user
  // then closes every tab, landing on the destination would yank the app off
  // the welcome screen they chose — the result reaches them as a toast instead.
  it("skips reopening the destination when every tab closed mid-move", async () => {
    const slowMove = deferred<string>();
    useRepo.setState({ summary, openPaths: ["/repo"], loading: false });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "move_branch_to_worktree") return slowMove.promise;
      if (cmd === "open_repo") return Promise.resolve(summary);
      return defaultInvoke(cmd);
    });

    const move = useRepo
      .getState()
      .moveBranchToWorktree("feature", "/repo-feature", "/repo", true);
    useRepo.setState({ openPaths: [], summary: null });
    slowMove.resolve("Moved feature to repo");

    await expect(move).resolves.toBe("Moved feature to repo");
    expect(invokeMock).not.toHaveBeenCalledWith("open_repo", expect.anything());
    expect(useRepo.getState().summary).toBeNull();
    expect(useRepo.getState().loading).toBe(false);
  });
});

// The delete-branch-and-worktree dialog is repo-bound like confirm/prompt, but —
// unlike hand-off — it never switches repos itself (success refreshes the same
// repo). So ANY genuine switch must clear it, running or not; an in-flight delete
// keeps going and reports via toast (GL-107).
describe("repo store — delete-worktree overlay lifecycle", () => {
  const openDeleteDialog = () =>
    useUi.setState({
      deleteWorktree: { branch: "feature", worktreePath: "/repo-feature" },
      deleteWorktreeRunning: false,
    });
  const switchInvoke = (path: string) => (cmd: string) => {
    if (cmd === "open_repo") return Promise.resolve({ ...summary, path, workdir: path });
    if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
    return defaultInvoke(cmd);
  };

  it("closes the delete dialog on a genuine repo switch", async () => {
    openDeleteDialog();
    invokeMock.mockImplementation(switchInvoke("/other"));
    await useRepo.getState().loadRepo("/other");
    expect(useUi.getState().deleteWorktree).toBeNull();
  });

  it("closes it even while a delete is in flight (the run reports via toast)", async () => {
    openDeleteDialog();
    useUi.setState({ deleteWorktreeRunning: true });
    invokeMock.mockImplementation(switchInvoke("/other"));
    await useRepo.getState().loadRepo("/other");
    expect(useUi.getState().deleteWorktree).toBeNull();
    useUi.setState({ deleteWorktreeRunning: false });
  });

  it("closes the dialog when the last tab closes", async () => {
    openDeleteDialog();
    useRepo.setState({ summary, openPaths: ["/repo"] });
    await useRepo.getState().closeRepo("/repo");
    expect(useUi.getState().deleteWorktree).toBeNull();
  });
});

describe("repo store — reorderOpenPaths", () => {
  it("reorders open repo tabs and keeps the active repo selected", () => {
    localStorage.clear();
    useRepo.setState({
      summary: { ...summary, path: "/b" },
      openPaths: ["/a", "/b", "/c"],
    });

    useRepo.getState().reorderOpenPaths(2, 0);

    expect(useRepo.getState().openPaths).toEqual(["/c", "/a", "/b"]);
    expect(useRepo.getState().summary?.path).toBe("/b");
    expect(JSON.parse(localStorage.getItem("gitlane.openPaths:v1") ?? "[]")).toEqual([
      "/c",
      "/a",
      "/b",
    ]);
    expect(localStorage.getItem("gitlane.lastPath")).toBe("/b");
  });

  it("keeps the active repo selected when its own tab is dragged", () => {
    localStorage.clear();
    useRepo.setState({
      summary: { ...summary, path: "/a" },
      openPaths: ["/a", "/b", "/c"],
    });

    // Drag the active tab (/a) from the front to the end.
    useRepo.getState().reorderOpenPaths(0, 2);

    expect(useRepo.getState().openPaths).toEqual(["/b", "/c", "/a"]);
    expect(useRepo.getState().summary?.path).toBe("/a");
    expect(JSON.parse(localStorage.getItem("gitlane.openPaths:v1") ?? "[]")).toEqual([
      "/b",
      "/c",
      "/a",
    ]);
    expect(localStorage.getItem("gitlane.lastPath")).toBe("/a");
  });

  it("ignores invalid or same-index reorder requests", () => {
    localStorage.clear();
    useRepo.setState({
      summary,
      openPaths: ["/a", "/b"],
    });

    useRepo.getState().reorderOpenPaths(1, 1);
    useRepo.getState().reorderOpenPaths(-1, 0);
    useRepo.getState().reorderOpenPaths(0, 2);

    expect(useRepo.getState().openPaths).toEqual(["/a", "/b"]);
    expect(localStorage.getItem("gitlane.openPaths:v1")).toBeNull();
  });
});

describe("repo store — loadRepo failed open", () => {
  it("keeps the previous repo's summary + graph/refs/changes intact when open_repo fails", async () => {
    // A fully-loaded previous repo. open_repo is the cheap first step of an open;
    // if it throws (invalid folder), the toolbar must not be left pointing at the
    // old repo over an emptied graph/navigator (GL-20 review fix).
    const prevSummary: RepoSummary = {
      path: "/old",
      workdir: "/old",
      headBranch: "main",
      headOid: "abc1234",
      detached: false,
    };
    const prevGraph: RepoGraph = { ...emptyGraph, head: "abc1234" };
    const prevBranches: BranchInfo[] = [
      { name: "main", kind: "local", target: "abc1234", isHead: true, upstream: null, remote: null },
    ];
    const prevWorktrees: WorktreeInfo[] = [
      { name: "old", path: "/old", branch: "main", isMain: true },
    ];
    const prevStashes: StashEntry[] = [
      { index: 0, message: "wip", oid: "s1", timestamp: 0, baseOid: "abc1234", baseTimestamp: 0, context: [] },
    ];
    const prevChanges: WorkingChanges = {
      staged: [{ path: "a.ts", status: "M", add: 1, del: 0, binary: false }],
      unstaged: [],
      conflicted: [],
      advanced: emptyAdvancedState,
    };
    useRepo.setState({
      summary: prevSummary,
      graph: prevGraph,
      branches: prevBranches,
      worktrees: prevWorktrees,
      stashes: prevStashes,
      changes: prevChanges,
      selectedCommit: "abc1234",
      selectedCommits: ["abc1234"],
      loading: false,
      graphLoading: false,
      error: null,
    });

    invokeMock.mockRejectedValueOnce(new Error("not a git repository"));

    await useRepo.getState().loadRepo("/does-not-exist");

    const s = useRepo.getState();
    // Summary AND its data survive together — not a live summary over empty data.
    expect(s.summary).toBe(prevSummary);
    expect(s.graph).toBe(prevGraph);
    expect(s.branches).toBe(prevBranches);
    expect(s.worktrees).toBe(prevWorktrees);
    expect(s.stashes).toBe(prevStashes);
    expect(s.changes).toBe(prevChanges);
    // …and the failure surfaces, with both loading flags cleared.
    expect(s.error).toContain("not a git repository");
    expect(s.loading).toBe(false);
    expect(s.graphLoading).toBe(false);
    // open_repo was the only call; no data slice fanned out past the failure.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("open_repo", { path: "/does-not-exist" });
  });
});

describe("repo store — loadRepo progressive open", () => {
  it("resets stale PR state before the commit graph resolves", async () => {
    // A previous repo's PRs are still in the store when a new open begins.
    usePulls.setState({
      pullRequests: [{ num: 99 } as unknown as PullRequest],
      prDetails: { 99: { num: 99 } as unknown as PullRequest },
      prError: "stale error",
      prsFetchedAt: 123,
    });

    // Hold the graph open: its payload is the slow part of an open, so this is
    // exactly the window where the ActionBar could pair the new summary with the
    // old repo's PRs (GL-20 review fix).
    const graphDeferred = deferred<RepoGraph>();
    let prsAtGraphCall: PullRequest[] | null = null;
    let prErrorAtGraphCall: string | null = "unset";
    let graphLoadingAtGraphCall = false;
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          // Snapshot PR + loading state at the instant the graph load begins —
          // i.e. after the synchronous reset, before the graph resolves.
          prsAtGraphCall = usePulls.getState().pullRequests;
          prErrorAtGraphCall = usePulls.getState().prError;
          graphLoadingAtGraphCall = useRepo.getState().graphLoading;
          return graphDeferred.promise;
        default:
          // list_branches / list_worktrees / list_stashes / working_changes /
          // list_pull_requests / repo_identity / watch_repo.
          return defaultInvoke(cmd);
      }
    });

    const open = useRepo.getState().loadRepo("/repo");
    // Let loadRepo run through openRepo + the synchronous PR reset and park on
    // the (still-pending) commit_graph await.
    await new Promise((resolve) => setTimeout(resolve));

    expect(prsAtGraphCall).toEqual([]);
    expect(prErrorAtGraphCall).toBeNull();
    expect(graphLoadingAtGraphCall).toBe(true);

    graphDeferred.resolve(emptyGraph);
    await open;
  });

  it("defaults the selection to the newest real commit, skipping an interleaved stash node", async () => {
    // A fresh stash sorts above HEAD, so the Rust layout puts it at commits[0].
    // The default selection must skip it and land on the newest real commit, or
    // the inspector would load a stash oid as a commit.
    const graph: RepoGraph = {
      ...emptyGraph,
      head: "real-tip",
      commits: [
        node({ id: "s0", stash: { index: 0, message: "WIP" } }),
        node({ id: "real-tip" }),
      ],
    };
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(graph);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [] });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().loadRepo("/repo");

    expect(useRepo.getState().selectedCommit).toBe("real-tip");
  });

  it("surfaces an error when the required list_branches read fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        case "list_branches":
          return Promise.reject(new Error("branches boom"));
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().loadRepo("/repo");
    // The required-slice catch sets `error` from a fire-and-forget read; drain
    // pending microtasks before asserting.
    await new Promise((resolve) => setTimeout(resolve));

    expect(useRepo.getState().error).toContain("branches boom");
  });

  it("surfaces an error when the required working_changes read fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        case "working_changes":
          return Promise.reject(new Error("status boom"));
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));

    expect(useRepo.getState().error).toContain("status boom");
  });

  it("stays error-free when a best-effort read (list_stashes) fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        case "list_stashes":
          return Promise.reject(new Error("stashes boom"));
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));

    // Worktrees/stashes degrade silently to empty — only branches/working changes
    // are required state.
    expect(useRepo.getState().error).toBeNull();
  });

  it("does not orphan an in-flight graph when a later pick fails to open", async () => {
    const summaryA: RepoSummary = {
      path: "/a",
      workdir: "/a",
      headBranch: "main",
      headOid: null,
      detached: false,
    };
    const graphA = deferred<RepoGraph>();
    invokeMock.mockImplementation((cmd: string, args: { path?: string }) => {
      if (cmd === "open_repo") {
        return args.path === "/a"
          ? Promise.resolve(summaryA)
          : Promise.reject(new Error("bad pick"));
      }
      if (cmd === "commit_graph") return graphA.promise;
      return defaultInvoke(cmd);
    });

    // Open A; park it on the (still-pending) graph load.
    const openA = useRepo.getState().loadRepo("/a");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().summary).toBe(summaryA);
    expect(useRepo.getState().graphLoading).toBe(true);

    // A second pick fails at open_repo. It must surface its error WITHOUT
    // superseding A's load — no generation bump, no flag changes (GL-20 review).
    await useRepo.getState().loadRepo("/does-not-exist");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().error).toContain("bad pick");
    expect(useRepo.getState().summary).toBe(summaryA);
    expect(useRepo.getState().graphLoading).toBe(true);
    expect(useRepo.getState().loading).toBe(true);

    // A's graph resolves and still paints — it was never orphaned.
    graphA.resolve(emptyGraph);
    await openA;
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().graph).toEqual(emptyGraph);
    expect(useRepo.getState().graphLoading).toBe(false);
    expect(useRepo.getState().loading).toBe(false);
  });

  it("keeps the newer pick active when an earlier slow open resolves last", async () => {
    const summaryA: RepoSummary = {
      path: "/a",
      workdir: "/a",
      headBranch: "a",
      headOid: null,
      detached: false,
    };
    const summaryB: RepoSummary = {
      path: "/b",
      workdir: "/b",
      headBranch: "b",
      headOid: null,
      detached: false,
    };
    const openA = deferred<RepoSummary>();
    invokeMock.mockImplementation((cmd: string, args: { path?: string }) => {
      if (cmd === "open_repo") {
        return args.path === "/a" ? openA.promise : Promise.resolve(summaryB);
      }
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return defaultInvoke(cmd);
    });

    // Pick A (its open hangs), then immediately pick B (opens fast → becomes active).
    const loadA = useRepo.getState().loadRepo("/a");
    await useRepo.getState().loadRepo("/b");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().summary).toBe(summaryB);

    // A's open finally resolves — as the superseded pick it must NOT publish over B.
    openA.resolve(summaryA);
    await loadA;
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().summary).toBe(summaryB);
    expect(useRepo.getState().graph).toEqual(emptyGraph);
  });

  it("does not error on the active repo when an older failed open rejects late", async () => {
    const summaryB: RepoSummary = {
      path: "/b",
      workdir: "/b",
      headBranch: "b",
      headOid: null,
      detached: false,
    };
    const openBad = deferred<RepoSummary>();
    invokeMock.mockImplementation((cmd: string, args: { path?: string }) => {
      if (cmd === "open_repo") {
        return args.path === "/bad" ? openBad.promise : Promise.resolve(summaryB);
      }
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return defaultInvoke(cmd);
    });

    // Pick a bad repo whose open hangs, then pick B which opens and becomes active.
    const loadBad = useRepo.getState().loadRepo("/bad");
    await useRepo.getState().loadRepo("/b");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().summary).toBe(summaryB);
    expect(useRepo.getState().error).toBeNull();

    // The older bad open finally rejects — it must NOT surface an error over B.
    openBad.reject(new Error("bad pick"));
    await loadBad;
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().error).toBeNull();
    expect(useRepo.getState().summary).toBe(summaryB);
  });

  it("honors a branch picked during the load instead of snapping to the tip", async () => {
    const loadedGraph: RepoGraph = {
      commits: [
        { id: "head", shortId: "head", summary: "head", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: [], lane: 0, row: 0, color: 0, refs: [] },
        { id: "tip", shortId: "tip", summary: "feat", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: ["head"], lane: 0, row: 1, color: 0, refs: [] },
      ],
      edges: [],
      laneCount: 1,
      head: "head",
      truncated: false,
    };
    const graphDeferred = deferred<RepoGraph>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return graphDeferred.promise;
      if (cmd === "commit_files") return Promise.resolve([{ path: "f.ts", status: "M", add: 1, del: 0, binary: false }]);
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return defaultInvoke(cmd);
    });
    useRepo.setState({ openPaths: ["/repo"] });

    const open = useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().graphLoading).toBe(true);

    // The branch navigator is usable while the skeleton shows — pick a branch tip.
    await useRepo.getState().revealCommit("tip");
    expect(useRepo.getState().selectedCommit).toBe("tip");

    // When the graph lands, the pick must survive (GL-20 review) — the graph would
    // otherwise scroll to "tip" (revealTarget) while the inspector showed HEAD.
    graphDeferred.resolve(loadedGraph);
    await open;
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().selectedCommit).toBe("tip");
    expect(useRepo.getState().revealTarget).toBe("tip");
  });

  it("falls back to the tip when a during-load pick is outside the loaded graph window", async () => {
    // The loaded window holds only head/tip; the user picks an old branch tip
    // beyond the initial limit, so it isn't in `graph.commits`.
    const loadedGraph: RepoGraph = {
      commits: [
        { id: "head", shortId: "head", summary: "head", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: [], lane: 0, row: 0, color: 0, refs: [] },
        { id: "tip", shortId: "tip", summary: "feat", body: "", authorName: "", authorEmail: "", timestamp: 0, parents: ["head"], lane: 0, row: 1, color: 0, refs: [] },
      ],
      edges: [],
      laneCount: 1,
      head: "head",
      truncated: true,
    };
    const graphDeferred = deferred<RepoGraph>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return graphDeferred.promise;
      if (cmd === "commit_files") return Promise.resolve([{ path: "f.ts", status: "M", add: 1, del: 0, binary: false }]);
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return defaultInvoke(cmd);
    });
    useRepo.setState({ openPaths: ["/repo"] });

    const open = useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));
    // Pick a commit that the loaded window will not contain.
    await useRepo.getState().revealCommit("old-out-of-window");
    expect(useRepo.getState().selectedCommit).toBe("old-out-of-window");

    graphDeferred.resolve(loadedGraph);
    await open;
    await new Promise((resolve) => setTimeout(resolve));

    // The unreachable pick is dropped: selection snaps to the tip and the stale
    // reveal is cleared so the inspector + graph can't disagree (GL-20 review).
    expect(useRepo.getState().selectedCommit).toBe("head");
    expect(useRepo.getState().revealTarget).toBeNull();
  });

  it("applies a slow secondary read even after a load-more bumps the graph generation", async () => {
    const branchesDeferred = deferred<BranchInfo[]>();
    const truncatedGraph: RepoGraph = { ...emptyGraph, truncated: true };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return Promise.resolve(truncatedGraph);
      if (cmd === "list_branches") return branchesDeferred.promise;
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return defaultInvoke(cmd);
    });
    useRepo.setState({ openPaths: ["/repo"], branches: [] });

    // Open completes (graph lands) while the branches read is still in flight.
    await useRepo.getState().loadRepo("/repo");
    // An unrelated "load more" bumps the graph generation mid-flight.
    await useRepo.getState().loadMoreHistory();

    const picked: BranchInfo[] = [
      { name: "main", kind: "local", target: "head", isHead: true, upstream: null, remote: null },
    ];
    branchesDeferred.resolve(picked);
    await new Promise((resolve) => setTimeout(resolve));

    // Guarded by repo identity, not the bumped generation, so it still lands
    // instead of being silently dropped (GL-20 review).
    expect(useRepo.getState().branches).toHaveLength(1);
  });

  it("replays a deferred watcher sync after a failed checkout", async () => {
    const checkoutDeferred = deferred<void>();
    let graphCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "checkout") return checkoutDeferred.promise;
      if (cmd === "commit_graph") {
        graphCalls += 1;
        return Promise.resolve(emptyGraph);
      }
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return defaultInvoke(cmd);
    });
    useRepo.setState({ summary, graph: emptyGraph, loading: false });

    const checkout = useRepo.getState().checkoutBranch("feature").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().loading).toBe(true);

    // A watcher event lands while the checkout holds `loading` → deferred, not run.
    await useRepo.getState().refresh({ prs: false, quiet: true, scope: "all" });
    expect(graphCalls).toBe(0);

    // The checkout fails; its catch must still replay the deferred sync (GL-20 review).
    checkoutDeferred.reject(new Error("conflict"));
    await checkout;
    await new Promise((resolve) => setTimeout(resolve));
    await new Promise((resolve) => setTimeout(resolve));

    expect(useRepo.getState().loading).toBe(false);
    expect(graphCalls).toBeGreaterThanOrEqual(1);
  });

  it("asks (reclaim here vs open) instead of silently entering the worktree holding the branch", async () => {
    const realOpenWorktree = useRepo.getState().openWorktree;
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      summary: { ...summary, headBranch: null, detached: true },
      worktrees: [
        { name: "repo", path: "/repo", branch: null, isMain: true },
        { name: "zen-chaum-e0e8aa", path: "/repo/.claude/worktrees/zen-chaum-e0e8aa", branch: "develop", isMain: false },
      ],
      openWorktree,
    });

    try {
      const message = await useRepo.getState().checkoutBranch("develop");

      // The dialog owns what happens next — no checkout, no tab switch, no toast.
      expect(message).toBe("");
      expect(openWorktree).not.toHaveBeenCalled();
      expect(invokeMock).not.toHaveBeenCalledWith("checkout", expect.anything());
      const confirm = useUi.getState().confirm;
      expect(confirm?.title).toBe("develop is in another worktree");
      // The holding worktree is named with its full path — the user must be
      // able to SEE what blocks the checkout.
      expect(confirm?.details).toEqual(["/repo/.claude/worktrees/zen-chaum-e0e8aa"]);

      // Primary: reclaim the branch here — the hand-off dialog opens with the
      // open worktree preselected as the destination.
      confirm?.onConfirm();
      expect(useUi.getState().handoff).toEqual({
        branch: "develop",
        sourcePath: "/repo/.claude/worktrees/zen-chaum-e0e8aa",
        sourceChanges: null,
        destPath: "/repo",
      });

      // Secondary: open the holding worktree (the old reroute, now opt-in).
      confirm?.secondary?.onClick();
      expect(confirm?.secondary?.label).toBe("Open that worktree");
      expect(openWorktree).toHaveBeenCalledWith("/repo/.claude/worktrees/zen-chaum-e0e8aa");
    } finally {
      useRepo.setState({ openWorktree: realOpenWorktree });
      useUi.setState({ confirm: null, handoff: null });
    }
  });

  it("re-validates live state when the reclaim confirm is accepted after a worktree change", async () => {
    const realOpenWorktree = useRepo.getState().openWorktree;
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    const showToast = vi.fn();
    const originalShowToast = useUi.getState().showToast;
    useUi.setState({ showToast });
    useRepo.setState({
      summary: { ...summary, headBranch: null, detached: true },
      worktrees: [
        { name: "repo", path: "/repo", branch: null, isMain: true },
        { name: "zen-chaum-e0e8aa", path: "/repo/.claude/worktrees/zen-chaum-e0e8aa", branch: "develop", isMain: false },
      ],
      openWorktree,
    });

    try {
      await useRepo.getState().checkoutBranch("develop");
      const confirm = useUi.getState().confirm;
      expect(confirm?.title).toBe("develop is in another worktree");

      // The confirm sits open while a watcher refresh moves the branch out of
      // the holder — accepting must NOT start a handoff from the stale snapshot.
      useRepo.setState({
        worktrees: [
          { name: "repo", path: "/repo", branch: null, isMain: true },
          { name: "zen-chaum-e0e8aa", path: "/repo/.claude/worktrees/zen-chaum-e0e8aa", branch: null, isMain: false },
        ],
      });
      confirm?.onConfirm();

      expect(useUi.getState().handoff).toBeNull();
      expect(showToast).toHaveBeenCalledWith(
        "develop moved while the dialog was open. Try again.",
        "error",
      );
    } finally {
      useRepo.setState({ openWorktree: realOpenWorktree });
      useUi.setState({ confirm: null, handoff: null, showToast: originalShowToast });
    }
  });

  it("falls back to opening the holding worktree when the open repo can't take the branch", async () => {
    const realOpenWorktree = useRepo.getState().openWorktree;
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      summary: { ...summary, headBranch: null, detached: true },
      worktrees: [
        // A bare main checkout is not a valid hand-off destination, so the
        // reclaim dialog can't be offered — keep the old open-reroute.
        { name: "repo", path: "/repo", branch: null, isMain: true, bare: true },
        { name: "zen-chaum-e0e8aa", path: "/repo/.claude/worktrees/zen-chaum-e0e8aa", branch: "develop", isMain: false },
      ],
      openWorktree,
    });

    try {
      const message = await useRepo.getState().checkoutBranch("develop");

      expect(message).toBe("Opened develop worktree");
      expect(openWorktree).toHaveBeenCalledWith("/repo/.claude/worktrees/zen-chaum-e0e8aa");
      expect(useUi.getState().confirm).toBeNull();
      expect(invokeMock).not.toHaveBeenCalledWith("checkout", expect.anything());
    } finally {
      useRepo.setState({ openWorktree: realOpenWorktree });
    }
  });

  it("refreshes worktree ownership before checking out when the cached list is empty", async () => {
    const realOpenWorktree = useRepo.getState().openWorktree;
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_worktrees") {
        return Promise.resolve([
          { name: "repo", path: "/repo", branch: null, isMain: true },
          { name: "zen-chaum-e0e8aa", path: "/repo/.claude/worktrees/zen-chaum-e0e8aa", branch: "develop", isMain: false },
        ]);
      }
      return defaultInvoke(cmd);
    });
    useRepo.setState({
      summary: { ...summary, headBranch: null, detached: true },
      worktrees: [],
      openWorktree,
    });

    try {
      await useRepo.getState().checkoutBranch("develop");

      expect(invokeMock).toHaveBeenCalledWith("list_worktrees", { path: "/repo" });
      expect(useRepo.getState().worktrees).toHaveLength(2);
      // The freshly-discovered holder raises the same reclaim dialog.
      expect(openWorktree).not.toHaveBeenCalled();
      expect(useUi.getState().confirm?.title).toBe("develop is in another worktree");
      expect(invokeMock).not.toHaveBeenCalledWith("checkout", expect.anything());
    } finally {
      useRepo.setState({ openWorktree: realOpenWorktree });
      useUi.setState({ confirm: null });
    }
  });

  it("creates a tracking local branch when checking out a remote branch", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      if (cmd === "working_changes") return Promise.resolve(EMPTY_CHANGES);
      return defaultInvoke(cmd);
    });
    useRepo.setState({ summary, graph: emptyGraph, loading: false, worktrees: [] });

    await useRepo.getState().checkoutRemoteBranch("origin", "feature");

    expect(invokeMock).toHaveBeenCalledWith("list_worktrees", { path: "/repo" });
    expect(invokeMock).toHaveBeenCalledWith("checkout_remote_branch", {
      path: "/repo",
      remote: "origin",
      branch: "feature",
    });
    expect(useRepo.getState().loading).toBe(false);
  });

  it("fast-forwards a remote branch in its existing worktree before opening it", async () => {
    const realOpenWorktree = useRepo.getState().openWorktree;
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    const worktreePath = "/repo/.claude/worktrees/feature";
    useRepo.setState({
      summary,
      graph: emptyGraph,
      loading: false,
      worktrees: [
        { name: "repo", path: "/repo", branch: "main", isMain: true },
        { name: "feature", path: worktreePath, branch: "feature", isMain: false },
      ],
      openWorktree,
    });

    try {
      await useRepo.getState().checkoutRemoteBranch("origin", "feature");

      expect(invokeMock).toHaveBeenCalledWith("checkout_remote_branch", {
        path: worktreePath,
        remote: "origin",
        branch: "feature",
      });
      expect(openWorktree).toHaveBeenCalledWith(worktreePath);
      expect(useRepo.getState().loading).toBe(false);
    } finally {
      useRepo.setState({ openWorktree: realOpenWorktree });
    }
  });

  it("refreshes after remote checkout reports a partial failure", async () => {
    let graphCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "checkout_remote_branch") {
        return Promise.reject(new Error("feature is checked out, but it couldn't be fast-forwarded"));
      }
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") {
        graphCalls += 1;
        return Promise.resolve(emptyGraph);
      }
      if (cmd === "working_changes") return Promise.resolve(EMPTY_CHANGES);
      return defaultInvoke(cmd);
    });
    useRepo.setState({ summary, graph: emptyGraph, loading: false, worktrees: [] });

    await expect(
      useRepo.getState().checkoutRemoteBranch("origin", "feature"),
    ).rejects.toThrow("feature is checked out");

    expect(graphCalls).toBeGreaterThanOrEqual(1);
    expect(useRepo.getState().loading).toBe(false);
  });

  it("does not drop a deferred watcher sync when a manual refresh is superseded", async () => {
    const slowGraph = deferred<RepoGraph>();
    let graphCallsB = 0;
    invokeMock.mockImplementation((cmd: string, args: { path?: string }) => {
      if (cmd === "open_repo") {
        return Promise.resolve(
          args.path === "/b" ? { ...summary, path: "/b", workdir: "/b" } : summary,
        );
      }
      if (cmd === "commit_graph") {
        // The manual refresh on /repo hangs; the /b load and any replay resolve.
        if (args.path === "/b") graphCallsB += 1;
        return args.path === "/repo" ? slowGraph.promise : Promise.resolve(emptyGraph);
      }
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return defaultInvoke(cmd);
    });
    useRepo.setState({ summary, graph: emptyGraph, loading: false, openPaths: ["/repo", "/b"] });

    // A manual (non-quiet) refresh holds `loading` and hangs on its graph fetch.
    const manual = useRepo.getState().refresh({ prs: false });
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().loading).toBe(true);

    // A watcher event lands during that window → it must be deferred, not dropped.
    await useRepo.getState().refresh({ prs: false, quiet: true, scope: "all" });

    // A repo switch supersedes the in-flight manual refresh.
    const switched = useRepo.getState().loadRepo("/b");
    slowGraph.resolve(emptyGraph); // the superseded manual refresh resumes and bails
    await switched;
    await manual;
    await new Promise((resolve) => setTimeout(resolve));
    await new Promise((resolve) => setTimeout(resolve));

    // We landed on /b cleanly, and the deferred sync was ultimately replayed there
    // (a second /b graph fetch) rather than silently lost.
    expect(useRepo.getState().summary?.path).toBe("/b");
    expect(useRepo.getState().loading).toBe(false);
    expect(useRepo.getState().graphLoading).toBe(false);
    expect(graphCallsB).toBeGreaterThanOrEqual(2);
  });

  it("registers the filesystem watcher when the shell swaps, before the graph", async () => {
    const graphDeferred = deferred<RepoGraph>();
    let graphPendingAtWatch: boolean | null = null;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "watch_repo") {
        // The watcher is registered while the graph is still loading.
        graphPendingAtWatch =
          useRepo.getState().graph === null && useRepo.getState().graphLoading === true;
        return Promise.resolve(undefined);
      }
      if (cmd === "commit_graph") return graphDeferred.promise;
      return defaultInvoke(cmd);
    });

    const open = useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));

    expect(graphPendingAtWatch).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("watch_repo", { path: "/repo" });

    graphDeferred.resolve(emptyGraph);
    await open;
  });

  it("registers the watcher for the active repo even if the graph fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return Promise.reject(new Error("graph boom"));
      return defaultInvoke(cmd);
    });

    await useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));

    // The repo is open (summary published) so it must be watched, and the graph
    // failure still surfaces.
    expect(invokeMock).toHaveBeenCalledWith("watch_repo", { path: "/repo" });
    expect(useRepo.getState().error).toContain("graph boom");
    expect(useRepo.getState().graphLoading).toBe(false);
  });

  it("releases the replaced tab's watch on an in-place worktree switch (GL-116)", async () => {
    // The GL-110 in-place switch re-keys the tab from /old to /new; the per-tab
    // watcher map is keyed by path, so the /old watch must be released or it
    // leaks for the rest of the session.
    useRepo.setState({ summary: { ...summary, path: "/old" }, openPaths: ["/old"] });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve({ ...summary, path: "/new", workdir: "/new" });
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      return defaultInvoke(cmd);
    });

    await useRepo.getState().loadRepo("/new", { replaceTab: "/old" });
    await new Promise((resolve) => setTimeout(resolve));

    expect(useRepo.getState().openPaths).toEqual(["/new"]);
    expect(invokeMock).toHaveBeenCalledWith("watch_repo", { path: "/new" });
    expect(invokeMock).toHaveBeenCalledWith("unwatch_repo", { path: "/old" });
  });

  it("keeps the watch when replaceTab resolves to the same path (GL-116)", async () => {
    // A re-open of the already-active path must not unwatch the tab it just
    // re-armed (old === new key).
    useRepo.setState({ summary: { ...summary, path: "/repo" }, openPaths: ["/repo"] });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      return defaultInvoke(cmd);
    });

    await useRepo.getState().loadRepo("/repo", { replaceTab: "/repo" });
    await new Promise((resolve) => setTimeout(resolve));

    expect(invokeMock).not.toHaveBeenCalledWith("unwatch_repo", { path: "/repo" });
  });

  it("defers a watcher refresh during a graph load and replays it once loaded", async () => {
    const graphDeferred = deferred<RepoGraph>();
    let graphCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") {
        graphCalls += 1;
        return graphCalls === 1 ? graphDeferred.promise : Promise.resolve(emptyGraph);
      }
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return defaultInvoke(cmd);
    });
    useRepo.setState({ openPaths: ["/repo"] });

    const open = useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().loading).toBe(true);

    // A filesystem event lands while the graph is still loading: it must not be
    // dropped, but it also must not start a second graph fetch yet (GL-20 review).
    await useRepo.getState().refresh({ prs: false, quiet: true, scope: "all" });
    expect(graphCalls).toBe(1);

    // Finishing the load replays the deferred refresh as a fresh full sync.
    graphDeferred.resolve(emptyGraph);
    await open;
    await new Promise((resolve) => setTimeout(resolve));
    expect(graphCalls).toBeGreaterThanOrEqual(2);
  });

  it("clears the loading flags when the active tab is closed mid graph-load", async () => {
    const graphDeferred = deferred<RepoGraph>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "open_repo") return Promise.resolve(summary);
      if (cmd === "commit_graph") return graphDeferred.promise;
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return defaultInvoke(cmd);
    });
    useRepo.setState({ openPaths: ["/repo"] });

    const open = useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().loading).toBe(true);
    expect(useRepo.getState().graphLoading).toBe(true);

    await useRepo.getState().closeRepo("/repo");
    expect(useRepo.getState().summary).toBeNull();
    expect(useRepo.getState().loading).toBe(false);
    expect(useRepo.getState().graphLoading).toBe(false);

    // The orphaned graph resolving must not resurrect a loading state.
    graphDeferred.resolve(emptyGraph);
    await open;
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().loading).toBe(false);
    expect(useRepo.getState().graph).toBeNull();
  });

  it("clears the loading flags when closing to a neighbor whose open fails mid-load", async () => {
    const graphDeferred = deferred<RepoGraph>();
    invokeMock.mockImplementation((cmd: string, args: { path?: string }) => {
      if (cmd === "open_repo") {
        return args.path === "/repo"
          ? Promise.resolve(summary)
          : Promise.reject(new Error("neighbor fail"));
      }
      if (cmd === "commit_graph") return graphDeferred.promise;
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      return defaultInvoke(cmd);
    });
    useRepo.setState({ openPaths: ["/repo", "/other"] });

    const open = useRepo.getState().loadRepo("/repo");
    await new Promise((resolve) => setTimeout(resolve));
    expect(useRepo.getState().loading).toBe(true);

    await useRepo.getState().closeRepo("/repo");
    expect(useRepo.getState().openPaths).toEqual(["/other"]);
    expect(useRepo.getState().summary).toBeNull();
    expect(useRepo.getState().error).toContain("neighbor fail");
    expect(useRepo.getState().loading).toBe(false);
    expect(useRepo.getState().graphLoading).toBe(false);

    // The orphaned /repo graph resolving stays a no-op.
    graphDeferred.resolve(emptyGraph);
    await open;
    expect(useRepo.getState().loading).toBe(false);
  });
});

describe("repo store — fastForwardTo", () => {
  // Resolve every refresh fan-out command so runOp's trailing refresh() settles.
  function stubRefresh() {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [] });
        default:
          return defaultInvoke(cmd);
      }
    });
  }

  beforeEach(() => {
    useRepo.setState({
      summary: { ...summary, headOid: "1111111" },
      branches: [
        { name: "main", kind: "local", target: "1111111", isHead: true, upstream: null, remote: null },
        { name: "develop", kind: "local", target: "2222222", isHead: false, upstream: null, remote: null },
        { name: "origin/main", kind: "remote", target: "3333333", isHead: false, upstream: null, remote: "origin" },
        { name: "origin/develop", kind: "remote", target: "4444444", isHead: false, upstream: null, remote: "origin" },
      ],
    });
  });

  it("moves a non-current branch in place without a checkout", async () => {
    // On `main`, advance `develop` to `origin/develop`: no checkout, ref updated
    // via fast_forward_branch so the working tree stays put.
    useRepo.setState({ summary });
    stubRefresh();

    await useRepo.getState().fastForwardTo("origin/develop", "develop");

    expect(invokeMock).toHaveBeenCalledWith("fast_forward_branch", {
      path: "/repo",
      branch: "develop",
      expectedBranchOid: "2222222",
      targetOid: "4444444",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("checkout", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("fast_forward", expect.anything());
  });

  it("fast-forwards the current branch in the working tree", async () => {
    // The moved branch IS HEAD, so merge --ff-only the working tree forward.
    useRepo.setState({ summary });
    stubRefresh();

    await useRepo.getState().fastForwardTo("origin/main", "main");

    expect(invokeMock).toHaveBeenCalledWith("fast_forward_branch", {
      path: "/repo",
      branch: "main",
      expectedBranchOid: "1111111",
      targetOid: "3333333",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("fast_forward", expect.anything());
  });
});

describe("repo store — deleteTag", () => {
  function stubTagInvokes(overrides: Record<string, () => Promise<unknown>>) {
    invokeMock.mockImplementation((cmd: string) => {
      const hit = overrides[cmd];
      if (hit) return hit();
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        default:
          return defaultInvoke(cmd);
      }
    });
  }

  it("deletes on origin first, then locally, for the everywhere variant", async () => {
    useRepo.setState({ summary });
    const order: string[] = [];
    stubTagInvokes({
      delete_remote_tag: () => {
        order.push("remote");
        return Promise.resolve("ok");
      },
      delete_tag: () => {
        order.push("local");
        return Promise.resolve("ok");
      },
    });

    const msg = await useRepo.getState().deleteTag("v1", true);

    expect(order).toEqual(["remote", "local"]);
    expect(msg).toBe("Deleted tag v1 (local and origin)");
  });

  it("skips the local delete when origin rejects, so a retry starts unchanged", async () => {
    useRepo.setState({ summary });
    stubTagInvokes({
      delete_remote_tag: () => Promise.reject(new Error("auth failed")),
    });

    await expect(useRepo.getState().deleteTag("v1", true)).rejects.toThrow("auth failed");
    expect(invokeMock).not.toHaveBeenCalledWith("delete_tag", expect.anything());
  });

  it("names the half-applied state when the local delete fails after origin succeeded", async () => {
    useRepo.setState({ summary });
    stubTagInvokes({
      delete_remote_tag: () => Promise.resolve("ok"),
      delete_tag: () => Promise.reject(new Error("ref locked")),
    });

    await expect(useRepo.getState().deleteTag("v1", true)).rejects.toThrow(
      /on origin, but the local delete failed/,
    );
    // runOp only refreshes on success, so the catch path re-syncs quietly
    // before rethrowing — the UI must reflect whatever the failed half left.
    expect(invokeMock).toHaveBeenCalledWith("commit_graph", expect.anything());
  });

  it("local-only delete never touches the remote", async () => {
    useRepo.setState({ summary });
    stubTagInvokes({ delete_tag: () => Promise.resolve("ok") });

    await useRepo.getState().deleteTag("v1");

    expect(invokeMock).toHaveBeenCalledWith("delete_tag", { path: "/repo", name: "v1" });
    expect(invokeMock).not.toHaveBeenCalledWith("delete_remote_tag", expect.anything());
  });
});

describe("repo store — closeRepo clears forge", () => {
  it("drops the stale forge when the last repo closes", async () => {
    // `forge` keys the provider indicator independently of `summary`, so a leak
    // here would render a stale indicator on the welcome screen.
    const forge: RepoForge = {
      hasRemote: true,
      kind: ForgeKind.GitHub,
      forge: "GitHub",
      host: "github.com",
      webUrl: "https://github.com/o/r",
    };
    useRepo.setState({ openPaths: ["/repo"], summary, forge });

    await useRepo.getState().closeRepo("/repo");

    const s = useRepo.getState();
    expect(s.summary).toBeNull();
    expect(s.forge).toBeNull();
  });

  it("releases the closed tab's filesystem watch (GL-116)", async () => {
    useRepo.setState({ openPaths: ["/repo", "/other"], summary });

    await useRepo.getState().closeRepo("/other");

    expect(invokeMock).toHaveBeenCalledWith("unwatch_repo", { path: "/other" });
  });

  it("preserves a live fetch owner when its last tab closes", async () => {
    useRepo.setState({ openPaths: ["/repo"], summary, fetchingPath: "/repo" });

    await useRepo.getState().closeRepo("/repo");

    expect(useRepo.getState().summary).toBeNull();
    expect(useRepo.getState().fetchingPath).toBe("/repo");
  });
});

describe("repo store — conflict actions", () => {
  it("returns false (and does not throw) when a per-file resolution fails", async () => {
    // A failed git write must report failure so the UI keeps the user's
    // in-progress hunk choices instead of clearing them.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "accept_conflict_side") return Promise.reject(new Error("index.lock"));
      return defaultInvoke(cmd);
    });
    const ok = await useRepo.getState().acceptConflictSide("src/a.ts", "ours");
    expect(ok).toBe(false);
  });

  it("returns true when a per-file resolution succeeds", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "accept_conflict_side") return Promise.resolve("Resolved");
      if (cmd === "working_changes") return Promise.resolve({ staged: [], unstaged: [] });
      if (cmd === "operation_status")
        return Promise.resolve({ kind: "cherry-pick", canSkip: true, conflicts: [] });
      return defaultInvoke(cmd);
    });
    const ok = await useRepo.getState().resolveConflictFile("src/a.ts", "merged\n");
    expect(ok).toBe(true);
  });

  it("clears a stale operation when operation_status fails and no conflicts remain", async () => {
    // The conflicted bucket keeps unmerged paths visible independently, so a
    // failed detection with a clean conflict set means the operation is over.
    useRepo.setState({ operation: { kind: "merge", canSkip: false, files: [] } });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "working_changes")
        return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
      if (cmd === "operation_status") return Promise.reject(new Error("detect failed"));
      return defaultInvoke(cmd);
    });

    await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });

    expect(useRepo.getState().operation).toBeNull();
  });

  it("keeps the operation when detection fails but conflicts are still present", async () => {
    // A transient operation_status failure mid-resolution must not yank the
    // workspace away while conflicts remain in the worktree.
    const op: OperationState = { kind: "merge", canSkip: false, files: [] };
    useRepo.setState({ operation: op });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "working_changes")
        return Promise.resolve({
          staged: [],
          unstaged: [],
          conflicted: [{ path: "f.txt", status: "C", add: 0, del: 0, binary: false }],
        });
      if (cmd === "operation_status") return Promise.reject(new Error("detect failed"));
      return defaultInvoke(cmd);
    });

    await useRepo.getState().refresh({ quiet: true, prs: false, scope: "worktree" });

    expect(useRepo.getState().operation).toBe(op);
  });

  it("does not publish an operation's result onto a repo switched-to mid-await", async () => {
    // Repo A has an active operation; start continue, then switch to repo B
    // (with its own operation) before the git call resolves. The result must
    // not clobber B's state.
    const slow = deferred<string>();
    useRepo.setState({
      summary,
      operation: { kind: "merge", canSkip: false, files: [] },
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "continue_operation") return slow.promise;
      return defaultInvoke(cmd);
    });

    const pending = useRepo.getState().continueOperation();
    const opB: OperationState = { kind: "rebase", canSkip: true, files: [] };
    useRepo.setState({ summary: { ...summary, path: "/other" }, operation: opB });
    slow.resolve("ok");
    await pending;

    // B's operation is untouched: not cleared, not refreshed away.
    expect(useRepo.getState().summary?.path).toBe("/other");
    expect(useRepo.getState().operation).toBe(opB);
    // And no full refresh ran against B (only the continue_operation call fired).
    expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());
  });
});

describe("repo store — openWorktree", () => {
  const wtSummary: RepoSummary = {
    path: "/repo-wt",
    workdir: "/repo-wt",
    headBranch: "feature",
    headOid: null,
    detached: false,
  };
  // loadRepo would normally park the selection on this tip.
  const graphWithTip: RepoGraph = {
    ...emptyGraph,
    head: "tip",
    commits: [node({ id: "tip" })],
  };

  it("surfaces the WIP node when the opened worktree is dirty", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(wtSummary);
        case "commit_graph":
          return Promise.resolve(graphWithTip);
        case "working_changes":
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "a.ts", status: "M", add: 1, del: 0, binary: false }],
            conflicted: [],
          });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    // Opening a dirty worktree lands on its working tree, not the tip commit.
    expect(useRepo.getState().wipSelected).toBe(true);
    expect(useRepo.getState().selectedCommit).toBeNull();
  });

  it("keeps loadRepo's tip selection when the clean worktree's HEAD is unknown", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(wtSummary);
        case "commit_graph":
          return Promise.resolve(graphWithTip);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    expect(useRepo.getState().wipSelected).toBe(false);
    expect(useRepo.getState().selectedCommit).toBe("tip");
    expect(useRepo.getState().revealTarget).toBeNull();
  });

  it("reveals the worktree's HEAD row when the opened worktree is clean", async () => {
    // A detached worktree parked below the newest row: loadRepo's default
    // selection is commits[0] ("tip"), so without the reveal the switch lands
    // on the wrong commit with no scroll to where the worktree actually sits.
    const detachedSummary: RepoSummary = {
      ...wtSummary,
      headBranch: null,
      headOid: "old",
      detached: true,
    };
    const graphWithOld: RepoGraph = {
      ...emptyGraph,
      head: "old",
      commits: [node({ id: "tip" }), node({ id: "old" })],
    };
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(detachedSummary);
        case "commit_graph":
          return Promise.resolve(graphWithOld);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    expect(useRepo.getState().wipSelected).toBe(false);
    expect(useRepo.getState().selectedCommit).toBe("old");
    expect(useRepo.getState().revealTarget).toBe("old");
  });

  it("does not reveal HEAD when the opened worktree is dirty (WIP wins)", async () => {
    const detachedSummary: RepoSummary = {
      ...wtSummary,
      headBranch: null,
      headOid: "old",
      detached: true,
    };
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(detachedSummary);
        case "commit_graph":
          return Promise.resolve(graphWithTip);
        case "working_changes":
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "a.ts", status: "M", add: 1, del: 0, binary: false }],
            conflicted: [],
          });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    // The WIP row is always the top row, so it needs no scroll; revealing HEAD
    // would yank the view away from the working tree that was just surfaced.
    expect(useRepo.getState().wipSelected).toBe(true);
    expect(useRepo.getState().revealTarget).toBeNull();
  });

  it("skips the reveal when the status read fails (dirty state unknown)", async () => {
    const detachedSummary: RepoSummary = {
      ...wtSummary,
      headBranch: null,
      headOid: "old",
      detached: true,
    };
    const graphWithOld: RepoGraph = {
      ...emptyGraph,
      head: "old",
      commits: [node({ id: "tip" }), node({ id: "old" })],
    };
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(detachedSummary);
        case "commit_graph":
          return Promise.resolve(graphWithOld);
        case "working_changes":
          return Promise.reject(new Error("status failed"));
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    // The worktree may be dirty for all we know — revealing HEAD could yank it
    // away from its working tree. Keep loadRepo's default (newest row).
    expect(useRepo.getState().selectedCommit).toBe("tip");
    expect(useRepo.getState().revealTarget).toBeNull();
  });

  it("does not clobber a branch picked while the graph was loading (GL-20)", async () => {
    const detachedSummary: RepoSummary = {
      ...wtSummary,
      headBranch: null,
      headOid: "tip",
      detached: true,
    };
    const graphWithOld: RepoGraph = {
      ...emptyGraph,
      head: "tip",
      commits: [node({ id: "tip" }), node({ id: "old" })],
    };
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(detachedSummary);
        case "commit_graph": {
          // Emulate the user picking a branch in the navigator while the graph
          // skeleton is up: the pick lands after Phase 2 cleared the selection
          // and before the graph resolves, so loadRepo honors it.
          useRepo.setState({
            revealTarget: "old",
            selectedCommit: "old",
            selectedCommits: ["old"],
            selectionAnchor: "old",
          });
          return Promise.resolve(graphWithOld);
        }
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    // The during-load pick survives; the HEAD reveal must not overwrite it.
    expect(useRepo.getState().revealTarget).toBe("old");
    expect(useRepo.getState().selectedCommit).toBe("old");
  });

  it("does not clobber a selection made while the status read is in flight", async () => {
    const detachedSummary: RepoSummary = {
      ...wtSummary,
      headBranch: null,
      headOid: "old",
      detached: true,
    };
    const graphThreeDeep: RepoGraph = {
      ...emptyGraph,
      head: "old",
      commits: [node({ id: "tip" }), node({ id: "mid" }), node({ id: "old" })],
    };
    // Call #1 is loadRepo's fire-and-forget status fan-out; call #2 is
    // openWorktree's own await'd read. The selection flips during #2 —
    // after openWorktree snapshotted the parked selection, before its await
    // resumes — emulating a graph click while the status read is in flight.
    let statusCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(detachedSummary);
        case "commit_graph":
          return Promise.resolve(graphThreeDeep);
        case "working_changes":
          statusCalls += 1;
          if (statusCalls === 2) {
            useRepo.setState({ selectedCommit: "mid", selectedCommits: ["mid"], selectionAnchor: "mid" });
          }
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    // The user's click wins over the automatic HEAD reveal.
    expect(useRepo.getState().selectedCommit).toBe("mid");
    expect(useRepo.getState().revealTarget).toBeNull();
  });

  it("does not yank an in-flight selection to WIP when the worktree is dirty", async () => {
    const detachedSummary: RepoSummary = {
      ...wtSummary,
      headBranch: null,
      headOid: "old",
      detached: true,
    };
    const graphThreeDeep: RepoGraph = {
      ...emptyGraph,
      head: "old",
      commits: [node({ id: "tip" }), node({ id: "mid" }), node({ id: "old" })],
    };
    // Same shape as the clean-path race above, but the status read comes back
    // dirty: the user's click during the await must win over the automatic
    // selectWip() too — deliberate navigation beats the WIP auto-landing.
    let statusCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(detachedSummary);
        case "commit_graph":
          return Promise.resolve(graphThreeDeep);
        case "working_changes":
          statusCalls += 1;
          if (statusCalls === 2) {
            useRepo.setState({ selectedCommit: "mid", selectedCommits: ["mid"], selectionAnchor: "mid" });
          }
          return Promise.resolve({
            staged: [],
            unstaged: [{ path: "a.ts", status: "M", add: 1, del: 0, binary: false }],
            conflicted: [],
          });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    expect(useRepo.getState().selectedCommit).toBe("mid");
    expect(useRepo.getState().wipSelected).toBe(false);
  });

  it("skips the reveal when loadRepo already parked on the HEAD row", async () => {
    // A tip-aligned worktree: loadRepo's default selection is the newest row,
    // which IS the worktree's HEAD — re-revealing would only re-fetch files
    // and flash the row the user is already looking at.
    const tipSummary: RepoSummary = { ...wtSummary, headOid: "tip" };
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(tipSummary);
        case "commit_graph":
          return Promise.resolve(graphWithTip);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    expect(useRepo.getState().selectedCommit).toBe("tip");
    expect(useRepo.getState().revealTarget).toBeNull();
  });

  it("does nothing after a failed load (the previous repo stays untouched)", async () => {
    useRepo.setState({
      summary: {
        path: "/repo-main",
        workdir: "/repo-main",
        headBranch: "main",
        headOid: "tip",
        detached: false,
      },
      selectedCommit: "tip",
      revealTarget: null,
    });
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.reject(new Error("cannot open"));
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().openWorktree("/repo-wt");

    // loadRepo absorbed the failure and left the previous repo active — the
    // post-load status read and reveal must not run against it.
    expect(invokeMock.mock.calls.map((c) => c[0])).not.toContain("working_changes");
    expect(useRepo.getState().selectedCommit).toBe("tip");
    expect(useRepo.getState().revealTarget).toBeNull();
  });
});

describe("repo store — merged selection (GL-69)", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("re-fetches the union when a refresh trims the multi-selection", async () => {
    // Start with a 3-commit union; the refresh's graph drops commit "c".
    useRepo.setState({
      selectedCommit: "a",
      selectedCommits: ["a", "b", "c"],
      selectionDiff: {
        commits: ["a", "b", "c"],
        files: [{ path: "stale.ts", status: "M", add: 1, del: 0, binary: false }],
        loading: false,
        error: null,
      },
    });
    const trimmedGraph: RepoGraph = {
      ...emptyGraph,
      commits: [node({ id: "a", shortId: "a" }), node({ id: "b", shortId: "b" })],
      head: "a",
    };
    const freshFiles = [{ path: "fresh.ts", status: "A", add: 2, del: 0, binary: false }];
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(trimmedGraph);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
        case "selection_diff":
          return Promise.resolve(freshFiles);
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().refresh({ prs: false, quiet: true });
    await flush(); // the union re-fetch is fire-and-forget

    const diff = useRepo.getState().selectionDiff!;
    expect(useRepo.getState().selectedCommits).toEqual(["a", "b"]);
    expect(diff.commits).toEqual(["a", "b"]);
    expect(diff.files).toEqual(freshFiles);
    expect(diff.loading).toBe(false);
    // The union was reloaded for the trimmed set, not the stale [a,b,c].
    expect(invokeMock).toHaveBeenCalledWith("selection_diff", { path: "/repo", oids: ["a", "b"] });
  });

  it("retries the union on refresh when the cached one had an error", async () => {
    // A transient selection_diff failure must not survive ordinary re-syncs.
    useRepo.setState({
      selectedCommit: "a",
      selectedCommits: ["a", "b"],
      selectionDiff: { commits: ["a", "b"], files: [], loading: false, error: "boom" },
    });
    const graph: RepoGraph = {
      ...emptyGraph,
      commits: [node({ id: "a", shortId: "a" }), node({ id: "b", shortId: "b" })],
      head: "a",
    };
    const freshFiles = [{ path: "ok.ts", status: "M", add: 1, del: 0, binary: false }];
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "open_repo":
          return Promise.resolve(summary);
        case "commit_graph":
          return Promise.resolve(graph);
        case "working_changes":
          return Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
        case "selection_diff":
          return Promise.resolve(freshFiles);
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().refresh({ prs: false, quiet: true });
    await flush();

    const diff = useRepo.getState().selectionDiff!;
    expect(diff.error).toBeNull(); // the stale error was cleared
    expect(diff.files).toEqual(freshFiles); // and the union retried successfully
    expect(invokeMock).toHaveBeenCalledWith("selection_diff", { path: "/repo", oids: ["a", "b"] });
  });

  it("drops selectionDiff when a refresh collapses the selection to one commit", async () => {
    useRepo.setState({
      selectedCommit: "a",
      selectedCommits: ["a", "b"],
      selectionDiff: { commits: ["a", "b"], files: [], loading: false, error: null },
    });
    const oneLeft: RepoGraph = { ...emptyGraph, commits: [node({ id: "a", shortId: "a" })], head: "a" };
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "open_repo"
        ? Promise.resolve(summary)
        : cmd === "commit_graph"
          ? Promise.resolve(oneLeft)
          : cmd === "working_changes"
            ? Promise.resolve({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState })
            : defaultInvoke(cmd),
    );

    await useRepo.getState().refresh({ prs: false, quiet: true });
    await flush();

    expect(useRepo.getState().selectedCommits).toEqual(["a"]);
    expect(useRepo.getState().selectionDiff).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("selection_diff", expect.anything());
  });

  it("still publishes the union if a refresh reorders the same selection mid-fetch", async () => {
    // The stuck-loading regression: a background refresh re-publishes the same
    // commit *set* in a different order while the union fetch is in flight. The
    // resolved fetch must still publish (set-based guard), not bail on order.
    const graph: RepoGraph = {
      ...emptyGraph,
      commits: [node({ id: "a", shortId: "a" }), node({ id: "b", shortId: "b" })],
      head: "a",
    };
    useRepo.setState({ graph, selectedCommit: null, selectedCommits: [], selectionAnchor: null, selectionDiff: null });
    const slow = deferred<unknown>();
    const files = [{ path: "u.ts", status: "M", add: 1, del: 0, binary: false }];
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "selection_diff" ? slow.promise : defaultInvoke(cmd),
    );

    await useRepo.getState().selectCommitMulti("a", {}); // single
    const pending = useRepo.getState().selectCommitMulti("b", { additive: true }); // [a,b] — union in flight
    // A refresh re-publishes the same set reordered (focus-first), no re-fetch.
    useRepo.setState({
      selectedCommits: ["b", "a"],
      selectionDiff: { commits: ["b", "a"], files: [], loading: true, error: null },
    });
    slow.resolve(files);
    await pending;

    const diff = useRepo.getState().selectionDiff!;
    expect(diff.loading).toBe(false); // not stuck
    expect(diff.files).toEqual(files); // published despite the reorder
  });

  it("publishes only the latest union when selections change rapidly", async () => {
    const graph: RepoGraph = {
      ...emptyGraph,
      commits: [node({ id: "a", shortId: "a" }), node({ id: "b", shortId: "b" }), node({ id: "c", shortId: "c" })],
      head: "a",
    };
    useRepo.setState({ graph, selectedCommit: null, selectedCommits: [], selectionAnchor: null, selectionDiff: null });

    const slow = deferred<unknown>();
    const filesAB = [{ path: "ab.ts", status: "M", add: 1, del: 0, binary: false }];
    const filesABC = [{ path: "abc.ts", status: "A", add: 2, del: 0, binary: false }];
    let selectionCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "selection_diff") {
        selectionCalls += 1;
        // First union ([a,b]) is slow; the second ([a,b,c]) resolves immediately.
        return selectionCalls === 1 ? slow.promise : Promise.resolve(filesABC);
      }
      return defaultInvoke(cmd);
    });

    await useRepo.getState().selectCommitMulti("a", {}); // single
    const pending = useRepo.getState().selectCommitMulti("b", { additive: true }); // [a,b] — slow union
    await useRepo.getState().selectCommitMulti("c", { additive: true }); // [a,b,c] — fast union publishes
    slow.resolve(filesAB); // the stale [a,b] union lands late
    await pending;

    const diff = useRepo.getState().selectionDiff!;
    expect(diff.commits).toEqual(["a", "b", "c"]);
    expect(diff.files).toEqual(filesABC); // the stale [a,b] result was discarded
  });

  it("selectFile ignores a stale union diff after the selection set changes", async () => {
    useRepo.setState({
      selectedCommits: ["a", "b"],
      selectionDiff: { commits: ["a", "b"], files: [], loading: false, error: null },
      selectedFile: null,
      fileDiff: null,
    });
    const slow = deferred<unknown>();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "selection_diff_file" ? slow.promise : defaultInvoke(cmd),
    );

    const pending = useRepo.getState().selectFile("x.ts", "commit");
    // A new multi-selection lands (same file path, different commit set) before
    // the in-flight per-file diff resolves.
    useRepo.setState({ selectionDiff: { commits: ["a", "c"], files: [], loading: false, error: null } });
    slow.resolve({ path: "x.ts", status: "M", add: 9, del: 9, binary: false, hunks: [], truncated: false });
    await pending;

    // The stale diff must not publish over the newer selection.
    expect(useRepo.getState().fileDiff).toBeNull();
  });
});

describe("repo store — worktree tabs (GL-110)", () => {
  const mainSummary: RepoSummary = {
    path: "/repo",
    workdir: "/repo",
    headBranch: "main",
    headOid: null,
    detached: false,
    isWorktree: false,
    mainPath: null,
  };
  const wtSummary: RepoSummary = {
    path: "/repo/.claude/worktrees/lewin",
    workdir: "/repo/.claude/worktrees/lewin",
    headBranch: "d/lewin",
    headOid: null,
    detached: false,
    isWorktree: true,
    mainPath: "/repo",
  };

  const mockOpen = (byPath: Record<string, RepoSummary>) => {
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "open_repo") {
        const { path } = args as { path: string };
        return Promise.resolve(byPath[path] ?? { ...mainSummary, path, workdir: path });
      }
      if (cmd === "commit_graph") return Promise.resolve(emptyGraph);
      return defaultInvoke(cmd);
    });
  };

  beforeEach(() => {
    localStorage.clear();
    useRepo.setState({
      summary: mainSummary,
      openPaths: ["/repo", "/other"],
      tabInfoByPath: {
        "/repo": { isWorktree: false, mainPath: null, branch: "main" },
        "/other": { isWorktree: false, mainPath: null, branch: "main" },
      },
    });
  });

  it("switches the current tab in place by default (one repo, one tab)", async () => {
    mockOpen({ [wtSummary.path]: wtSummary });

    await useRepo.getState().openWorktree(wtSummary.path);

    // The worktree replaced the main checkout's tab — no sibling tab appeared.
    expect(useRepo.getState().openPaths).toEqual([wtSummary.path, "/other"]);
    expect(useRepo.getState().summary?.path).toBe(wtSummary.path);
    // The strip knows it's a worktree of /repo on d/lewin (label + grouping).
    expect(useRepo.getState().tabInfoByPath[wtSummary.path]).toEqual({
      isWorktree: true,
      mainPath: "/repo",
      branch: "d/lewin",
    });
    // The replaced tab's info no longer lingers.
    expect(useRepo.getState().tabInfoByPath["/repo"]).toBeUndefined();
    expect(JSON.parse(localStorage.getItem("gitlane.openPaths:v1") ?? "[]")).toEqual([
      wtSummary.path,
      "/other",
    ]);
  });

  it("opens a separate tab grouped next to the repository on newTab", async () => {
    mockOpen({ [wtSummary.path]: wtSummary });

    await useRepo.getState().openWorktree(wtSummary.path, { newTab: true });

    // Inserted right after /repo (its parent), not appended after /other.
    expect(useRepo.getState().openPaths).toEqual(["/repo", wtSummary.path, "/other"]);
    expect(useRepo.getState().summary?.path).toBe(wtSummary.path);
  });

  it("just activates a worktree that is already open in another tab", async () => {
    useRepo.setState({ openPaths: ["/repo", wtSummary.path] });
    mockOpen({ [wtSummary.path]: wtSummary });

    await useRepo.getState().openWorktree(wtSummary.path);

    // No duplicate tab, no replacement — the existing tab became active.
    expect(useRepo.getState().openPaths).toEqual(["/repo", wtSummary.path]);
    expect(useRepo.getState().summary?.path).toBe(wtSummary.path);
  });
});

describe("repo store — restoreSession heals dead tabs (GL-109)", () => {
  const aliveSummary: RepoSummary = {
    path: "/a",
    workdir: "/a",
    headBranch: "main",
    headOid: null,
    detached: false,
    isWorktree: false,
    mainPath: null,
  };

  beforeEach(() => {
    localStorage.clear();
    useRepo.setState({
      summary: null,
      openPaths: ["/a", "/dead-wt"],
      sessionRestorePhase: SESSION_RESTORE_PHASE.Pending,
      // The persisted tab info is what lets restore recognize the dead path as
      // a *worktree* (the gone directory can't answer anymore).
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/dead-wt": { isWorktree: true, mainPath: "/a", branch: "d/lewin" },
      },
    });
  });

  it("marks open tabs for restoration even when the last-active path is missing", () => {
    expect(initialSessionRestorePhase(["/a"], null)).toBe(SESSION_RESTORE_PHASE.Pending);
    expect(initialSessionRestorePhase([], null)).toBe(SESSION_RESTORE_PHASE.Complete);
  });

  it("still probes and heals open tabs when the last-active path is missing", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "recents_status") {
        return Promise.resolve([
          { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
          { path: "/dead-wt", exists: false, branch: null, isWorktree: false, mainPath: null },
        ]);
      }
      return defaultInvoke(cmd);
    });

    await useRepo.getState().restoreSession();

    expect(invokeMock).toHaveBeenCalledWith("recents_status", {
      paths: ["/a", "/dead-wt"],
    });
    expect(invokeMock).not.toHaveBeenCalledWith("open_repo", expect.anything());
    expect(useRepo.getState().openPaths).toEqual(["/a"]);
    expect(useRepo.getState().sessionRestorePhase).toBe(SESSION_RESTORE_PHASE.Complete);
  });

  it("drops a removed worktree tab and heals the last-active path to a survivor", async () => {
    localStorage.setItem("gitlane.lastPath", "/dead-wt");
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "recents_status":
          return Promise.resolve([
            { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
            // A pruned agent worktree: gone from disk since last session.
            { path: "/dead-wt", exists: false, branch: null, isWorktree: false, mainPath: null },
          ]);
        case "open_repo":
          return Promise.resolve(aliveSummary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().restoreSession();

    // The dead tab is gone instead of restoring as an error tab, and the app
    // reopened on the surviving repo.
    expect(useRepo.getState().openPaths).toEqual(["/a"]);
    expect(useRepo.getState().summary?.path).toBe("/a");
    expect(useRepo.getState().sessionRestorePhase).toBe(SESSION_RESTORE_PHASE.Complete);
    expect(JSON.parse(localStorage.getItem("gitlane.openPaths:v1") ?? "[]")).toEqual(["/a"]);
    expect(localStorage.getItem("gitlane.lastPath")).toBe("/a");
  });

  it("keeps a missing *repository* tab for the GL-108 recovery screen", async () => {
    // A dead path that was NOT a worktree (a repo on an unmounted volume):
    // the tab must survive so Retry/Locate stay reachable.
    useRepo.setState({
      openPaths: ["/a", "/gone-repo"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/gone-repo": { isWorktree: false, mainPath: null, branch: "main" },
      },
    });
    localStorage.setItem("gitlane.lastPath", "/a");
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "recents_status":
          return Promise.resolve([
            { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
            { path: "/gone-repo", exists: false, branch: null, isWorktree: false, mainPath: null },
          ]);
        case "open_repo":
          return Promise.resolve(aliveSummary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().restoreSession();

    expect(useRepo.getState().openPaths).toEqual(["/a", "/gone-repo"]);
    expect(useRepo.getState().summary?.path).toBe("/a");
  });

  it("keeps restored tabs when the probe itself fails", async () => {
    localStorage.setItem("gitlane.lastPath", "/a");
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "recents_status":
          return Promise.reject(new Error("probe failed"));
        case "open_repo":
          return Promise.resolve(aliveSummary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().restoreSession();

    expect(useRepo.getState().openPaths).toEqual(["/a", "/dead-wt"]);
    expect(useRepo.getState().summary?.path).toBe("/a");
  });

  it("watches every live background tab so it doesn't go stale (GL-116)", async () => {
    // Two live repos: /a is the last-active (watched by loadRepo), /b is a
    // background tab that no loadRepo ever runs for until activated — it must
    // still get its own watch on restore.
    useRepo.setState({
      openPaths: ["/a", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/b": { isWorktree: false, mainPath: null, branch: "dev" },
      },
    });
    localStorage.setItem("gitlane.lastPath", "/a");
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "recents_status":
          return Promise.resolve([
            { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
            { path: "/b", exists: true, branch: "dev", isWorktree: false, mainPath: null },
          ]);
        case "open_repo":
          return Promise.resolve(aliveSummary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().restoreSession();

    // The background tab is watched by path; the active one is watched by
    // loadRepo (also by path) rather than left to this fallback.
    expect(invokeMock).toHaveBeenCalledWith("watch_repo", { path: "/b" });
    expect(invokeMock).toHaveBeenCalledWith("watch_repo", { path: "/a" });
  });

  it("never watches a dead background tab (GL-116)", async () => {
    localStorage.setItem("gitlane.lastPath", "/a");
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "recents_status":
          return Promise.resolve([
            { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
            { path: "/dead-wt", exists: false, branch: null, isWorktree: false, mainPath: null },
          ]);
        case "open_repo":
          return Promise.resolve(aliveSummary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        default:
          return defaultInvoke(cmd);
      }
    });

    await useRepo.getState().restoreSession();

    expect(invokeMock).not.toHaveBeenCalledWith("watch_repo", { path: "/dead-wt" });
  });

  it("claims startup restoration once while it is in flight", async () => {
    localStorage.setItem("gitlane.lastPath", "/a");
    const statusProbe = deferred<
      Array<{ path: string; exists: boolean; branch: string; isWorktree: boolean; mainPath: null }>
    >();
    invokeMock.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "recents_status":
          return statusProbe.promise;
        case "open_repo":
          return Promise.resolve(aliveSummary);
        case "commit_graph":
          return Promise.resolve(emptyGraph);
        default:
          return defaultInvoke(cmd);
      }
    });

    const firstRestore = useRepo.getState().restoreSession();
    const duplicateRestore = useRepo.getState().restoreSession();

    expect(useRepo.getState().sessionRestorePhase).toBe(SESSION_RESTORE_PHASE.Restoring);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "recents_status")).toHaveLength(1);

    statusProbe.resolve([
      { path: "/a", exists: true, branch: "main", isWorktree: false, mainPath: null },
      { path: "/dead-wt", exists: false, branch: "", isWorktree: false, mainPath: null },
    ]);
    await Promise.all([firstRestore, duplicateRestore]);

    expect(useRepo.getState().summary?.path).toBe("/a");
    expect(useRepo.getState().sessionRestorePhase).toBe(SESSION_RESTORE_PHASE.Complete);
  });
});

describe("repo store — refreshTabInfo (GL-116 background-tab labels)", () => {
  beforeEach(() => {
    localStorage.clear();
    useRepo.setState({
      openPaths: ["/a", "/b"],
      tabInfoByPath: {
        "/a": { isWorktree: false, mainPath: null, branch: "main" },
        "/b": { isWorktree: false, mainPath: null, branch: "old" },
      },
    });
  });

  it("re-probes one tab's identity without loading the repo", async () => {
    invokeMock.mockImplementation((cmd: string, args?: { paths?: string[] }) => {
      if (cmd === "recents_status") {
        expect(args?.paths).toEqual(["/b"]);
        return Promise.resolve([
          { path: "/b", exists: true, branch: "new", isWorktree: true, mainPath: "/a" },
        ]);
      }
      return defaultInvoke(cmd);
    });

    await useRepo.getState().refreshTabInfo("/b");

    // The label follows the fresh probe; the repo was never opened.
    expect(useRepo.getState().tabInfoByPath["/b"]).toEqual({
      isWorktree: true,
      mainPath: "/a",
      branch: "new",
    });
    expect(useRepo.getState().tabInfoByPath["/a"].branch).toBe("main");
    expect(invokeMock).not.toHaveBeenCalledWith("open_repo", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("commit_graph", expect.anything());
  });

  it("keeps the last-known label when the tab probes gone", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "recents_status"
        ? Promise.resolve([
            { path: "/b", exists: false, branch: null, isWorktree: false, mainPath: null },
          ])
        : defaultInvoke(cmd),
    );

    await useRepo.getState().refreshTabInfo("/b");

    expect(useRepo.getState().tabInfoByPath["/b"].branch).toBe("old");
  });

  it("drops the update if the tab closed while probing", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "recents_status"
        ? Promise.resolve([
            { path: "/b", exists: true, branch: "new", isWorktree: false, mainPath: null },
          ])
        : defaultInvoke(cmd),
    );

    const probe = useRepo.getState().refreshTabInfo("/b");
    // The tab closes before the probe resolves.
    useRepo.setState({ openPaths: ["/a"] });
    await probe;

    expect(useRepo.getState().tabInfoByPath["/b"]?.branch).toBe("old");
  });
});
