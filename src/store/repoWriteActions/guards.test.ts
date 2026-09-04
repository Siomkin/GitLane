// What the write actions refuse, and what they report when they run.
//
// Split out of the former src/store/repo.test.ts, which reached 5 122 lines;
// shared data fixtures live in @/test/repoFixtures.

import { emptyIpcInvoke } from "@/test/ipcFixtures";
import type { OperationState } from "@/store/repo";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary so the store's async actions run headlessly. `vi.mock`
// is hoisted above the import below; `vi.hoisted` makes `invokeMock` exist in time.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { defaultInvoke, deferred, emptyGraph, summary } from "@/test/repoFixtures";

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
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["/*", "!/*/", "/src/"], truncated: false },
        },
      },
    });

    try {
      await useRepo.getState().stageFile("docs/hidden.txt");

      expect(invokeMock).not.toHaveBeenCalledWith("stage_files", expect.anything());
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
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["/*", "!/*/", "/src/"], truncated: false },
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
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["src/"], truncated: false },
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

  it("passes only previewed reset tips through to reset_to (no live OID fallback)", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ refresh });
    invokeMock.mockResolvedValue("Reset");

    await useRepo.getState().resetBranchTo("main", "abc", "hard", {
      summary: "Reset hard",
      details: [],
      warnings: [],
      targetOid: "target-oid",
      expectedSourceOid: "source-oid",
      expectedState: "v2:lease",
      expectedHeadBranch: "main",
      expectedHeadOid: "source-oid",
    });

    expect(invokeMock).toHaveBeenCalledWith("reset_to", {
      path: "/repo",
      source: "main",
      expectedSourceOid: "source-oid",
      targetOid: "target-oid",
      mode: "hard",
      expectedState: "v2:lease",
      expectedHeadBranch: "main",
      expectedHeadOid: "source-oid",
    });
  });

  it("rejects hard reset without the preview lease fields", async () => {
    await expect(
      useRepo.getState().resetBranchTo("main", "abc", "hard", {
        summary: "Reset hard",
        details: [],
        warnings: [],
        targetOid: "",
        expectedSourceOid: "source-oid",
        expectedState: null,
        expectedHeadBranch: "main",
        expectedHeadOid: "source-oid",
      }),
    ).rejects.toThrow(/previewed target commit/);

    await expect(
      useRepo.getState().resetBranchTo("main", "abc", "hard", {
        summary: "Reset hard",
        details: [],
        warnings: [],
        targetOid: "target-oid",
        expectedSourceOid: null,
        expectedState: "v2:lease",
        expectedHeadBranch: "main",
        expectedHeadOid: "source-oid",
      }),
    ).rejects.toThrow(/no expected commit/);

    await expect(
      useRepo.getState().resetBranchTo("main", "abc", "hard", {
        summary: "Reset hard",
        details: [],
        warnings: [],
        targetOid: "target-oid",
        expectedSourceOid: "source-oid",
        expectedState: null,
        expectedHeadBranch: "main",
        expectedHeadOid: "source-oid",
      }),
    ).rejects.toThrow(/exact-state lease/);

    expect(invokeMock).not.toHaveBeenCalledWith(
      "reset_to",
      expect.anything(),
    );
  });

  it("deletes a branch with the previewed oid and repository path", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ refresh });
    invokeMock.mockResolvedValue("Deleted feature");

    await useRepo
      .getState()
      .removeBranch("feature", "2222222", "/repo", true);

    expect(invokeMock).toHaveBeenCalledWith("delete_branch", {
      path: "/repo",
      name: "feature",
      expectedOid: "2222222",
      force: true,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("rejects a branch-delete confirmation captured for a different active repo", async () => {
    useRepo.setState({ summary: { ...summary, path: "/other", workdir: "/other" } });

    await expect(
      useRepo.getState().removeBranch("feature", "2222222", "/repo", true),
    ).rejects.toThrow("Repository changed");
    expect(invokeMock).not.toHaveBeenCalledWith("delete_branch", expect.anything());
  });

  it("does not refresh a newly-active repo when it switches during branch deletion", async () => {
    const pending = deferred<string>();
    const refresh = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ refresh });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "delete_branch" ? pending.promise : defaultInvoke(cmd),
    );

    const deletion = useRepo
      .getState()
      .removeBranch("feature", "2222222", "/repo", true);
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("delete_branch", expect.anything()),
    );
    useRepo.setState({ summary: { ...summary, path: "/other", workdir: "/other" } });
    pending.resolve("Deleted feature");

    await expect(deletion).resolves.toBe("Deleted feature");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("attaches a branch to the captured detached worktree HEAD", async () => {
    await useRepo.getState().createBranchInWorktree(
      "/repo-detached",
      "topic/detached",
      "3333333",
    );

    expect(invokeMock).toHaveBeenCalledWith("create_branch_in_worktree", {
      path: "/repo",
      worktreePath: "/repo-detached",
      name: "topic/detached",
      expectedOid: "3333333",
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

    const msg = await useRepo.getState().deleteTag("v1", "tag-object-1", true);

    expect(order).toEqual(["remote", "local"]);
    expect(msg).toBe("Deleted tag v1 (local and origin)");
  });

  it("skips the local delete when origin rejects, so a retry starts unchanged", async () => {
    useRepo.setState({ summary });
    stubTagInvokes({
      delete_remote_tag: () => Promise.reject(new Error("auth failed")),
    });

    await expect(useRepo.getState().deleteTag("v1", "tag-object-1", true)).rejects.toThrow(
      "auth failed",
    );
    expect(invokeMock).not.toHaveBeenCalledWith("delete_tag", expect.anything());
  });

  it("names the half-applied state when the local delete fails after origin succeeded", async () => {
    useRepo.setState({ summary });
    stubTagInvokes({
      delete_remote_tag: () => Promise.resolve("ok"),
      delete_tag: () => Promise.reject(new Error("ref locked")),
    });

    await expect(useRepo.getState().deleteTag("v1", "tag-object-1", true)).rejects.toThrow(
      /on origin, but the local delete failed/,
    );
    // runOp only refreshes on success, so the catch path re-syncs quietly
    // before rethrowing — the UI must reflect whatever the failed half left.
    expect(invokeMock).toHaveBeenCalledWith("commit_graph", expect.anything());
  });

  it("local-only delete never touches the remote", async () => {
    useRepo.setState({ summary });
    stubTagInvokes({ delete_tag: () => Promise.resolve("ok") });

    await useRepo.getState().deleteTag("v1", "tag-object-1");

    expect(invokeMock).toHaveBeenCalledWith("delete_tag", {
      path: "/repo",
      name: "v1",
      expectedOid: "tag-object-1",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("delete_remote_tag", expect.anything());
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
          conflicted: [{ path: "f.txt", status: "X", add: 0, del: 0, binary: false }],
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

  it("does not report a rejected identity-preflight skip as conflict progress", async () => {
    const operation: OperationState = {
      kind: "cherry-pick",
      canSkip: true,
      files: [{ path: "f.txt", kind: "text", deletedSide: "", resolved: false }],
    };
    useRepo.setState({ summary, operation });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "skip_operation") {
        return Promise.reject(
          {
            kind: "staleLease",
            message: "The repository identity changed before this operation. Refresh and try again.",
          },
        );
      }
      return defaultInvoke(cmd);
    });

    await expect(useRepo.getState().skipOperation()).rejects.toThrow("identity changed");
    expect(useRepo.getState().operation).toBe(operation);
    expect(invokeMock).not.toHaveBeenCalledWith("working_changes", expect.anything());
  });
});
