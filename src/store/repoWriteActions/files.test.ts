// Working-tree file actions besides discard (covered in staging.test.ts):
// ignore, untrack, restore-from-commit and the OS hand-offs. Each one writes to
// the repo it captured, refreshes only while that repo is still active, and
// reports a failure as a toast instead of throwing.

import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { EMPTY_CHANGES, summary } from "@/test/repoFixtures";

const refresh = vi.fn(async () => true);
const showToast = vi.fn();
const originalShowToast = useUi.getState().showToast;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(emptyIpcInvoke);
  refresh.mockClear();
  showToast.mockClear();
  useUi.setState({ showToast });
  useRepo.setState({ summary, changes: EMPTY_CHANGES, refresh });
  return () => useUi.setState({ showToast: originalShowToast });
});

const failWith = (command: string, message: string) =>
  invokeMock.mockImplementation((cmd: string) =>
    cmd === command ? Promise.reject(new Error(message)) : emptyIpcInvoke(cmd),
  );

describe("repo store — file actions", () => {
  it("refuses a discard preview once the active repo changed", async () => {
    await expect(useRepo.getState().previewDiscardFile("/elsewhere", "a.ts", null, false)).rejects.toThrow(
      "The active repository changed",
    );
    expect(invokeMock).not.toHaveBeenCalledWith("preview_discard_file", expect.anything());
  });

  it("toasts a failed discard with a retry", async () => {
    failWith("discard_file", "lease is stale");

    await useRepo.getState().discardFile(summary.path, "a.ts", null, false, "dirty");

    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "lease is stale" }),
      "error",
      expect.objectContaining({ retry: expect.any(Function), repoPath: summary.path }),
    );
  });

  it("appends an ignore pattern to the repo, then refreshes", async () => {
    await useRepo.getState().appendIgnorePattern("*.log", true);

    expect(invokeMock).toHaveBeenCalledWith("append_ignore_pattern", {
      path: summary.path,
      pattern: "*.log",
      local: true,
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not refresh a repo the user left while the ignore write ran", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "append_ignore_pattern") {
        useRepo.setState({ summary: { ...summary, path: "/other" } });
      }
      return emptyIpcInvoke(cmd);
    });

    await useRepo.getState().appendIgnorePattern("*.log");

    expect(refresh).not.toHaveBeenCalled();
  });

  it("stops tracking a path and refreshes", async () => {
    await useRepo.getState().stopTracking("build/out.js");

    expect(invokeMock).toHaveBeenCalledWith("stop_tracking", { path: summary.path, file: "build/out.js" });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("toasts a failed untrack with a retry", async () => {
    failWith("stop_tracking", "pathspec did not match");

    await useRepo.getState().stopTracking("missing.js");

    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "pathspec did not match" }),
      "error",
      expect.objectContaining({ retry: expect.any(Function) }),
    );
  });

  it("restores a path from a commit and refreshes", async () => {
    await useRepo.getState().restorePathFromCommit("abc123", "src/a.ts");

    expect(invokeMock).toHaveBeenCalledWith("restore_path_from_commit", {
      path: summary.path,
      commitOid: "abc123",
      file: "src/a.ts",
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("toasts a failed restore and leaves the repo unrefreshed", async () => {
    failWith("restore_path_from_commit", "path not in commit");

    await useRepo.getState().restorePathFromCommit("abc123", "gone.ts");

    expect(refresh).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: "path not in commit" }),
      "error",
      expect.anything(),
    );
  });

  it.each([
    ["revealInFileManager", "reveal_in_file_manager"],
    ["openPathDefault", "open_path_default"],
    ["openPathDifftool", "open_path_difftool"],
  ] as const)("%s hands the path to the OS and toasts a failure", async (action, command) => {
    await useRepo.getState()[action]("src/a.ts");
    expect(invokeMock).toHaveBeenCalledWith(command, { path: summary.path, file: "src/a.ts" });

    failWith(command, "no handler");
    await useRepo.getState()[action]("src/a.ts");
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: "no handler" }), "error");
  });

  it("answers restore probes only for an open repo", async () => {
    useRepo.setState({ summary: null });

    await expect(useRepo.getState().worktreeDiffersFromCommit("abc123", "a.ts")).rejects.toThrow("No repository");
    await expect(useRepo.getState().commitPathIsRestorable("abc123", "a.ts")).resolves.toBe(false);
    await useRepo.getState().stopTracking("a.ts");
    expect(invokeMock).not.toHaveBeenCalledWith("stop_tracking", expect.anything());
  });
});
