// Line-range staging writes (commit review Include view): the request each
// action sends, the refresh after it, and the toast on failure.

import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { EMPTY_CHANGES, defaultInvoke, emptyGraph, summary } from "@/test/repoFixtures";
import type { DiffLineRange } from "@/lib/api";

const realRefresh = useRepo.getState().refresh;
const ranges: DiffLineRange[] = [
  { hunkIndex: 0, lineStart: 3, expected: [{ kind: "add", oldNo: null, newNo: 4, content: "x" }] },
];

const refreshInvoke = (cmd: string) => {
  switch (cmd) {
    case "apply_line_range":
    case "revert_line_range":
      return Promise.resolve("ok");
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

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(emptyIpcInvoke);
  useRepo.setState({ summary, selectedFile: null, fileDiff: null, refresh: realRefresh });
});

describe("repo store — line-range staging", () => {
  it("stages ranges through apply_line_range and refreshes", async () => {
    invokeMock.mockImplementation(refreshInvoke);
    await useRepo.getState().applyLineRange("src/a.ts", false, ranges);

    expect(invokeMock).toHaveBeenCalledWith("apply_line_range", {
      path: "/repo",
      request: { file: "src/a.ts", staged: false, ranges },
    });
    expect(invokeMock).toHaveBeenCalledWith("working_changes", expect.anything());
  });

  it("reverts ranges through revert_line_range as unstaged", async () => {
    invokeMock.mockImplementation(refreshInvoke);
    await useRepo.getState().revertLineRange("src/a.ts", ranges);

    expect(invokeMock).toHaveBeenCalledWith("revert_line_range", {
      path: "/repo",
      request: { file: "src/a.ts", staged: false, ranges },
    });
  });

  it("toasts a refused range instead of throwing", async () => {
    const showToast = vi.fn();
    const originalShowToast = useUi.getState().showToast;
    useUi.setState({ showToast });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "apply_line_range"
        ? Promise.reject("Those lines changed on disk. Refresh and try again.")
        : refreshInvoke(cmd),
    );
    try {
      await useRepo.getState().applyLineRange("src/a.ts", true, ranges);
      expect(showToast).toHaveBeenCalled();
    } finally {
      useUi.setState({ showToast: originalShowToast });
    }
  });
});
