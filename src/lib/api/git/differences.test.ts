import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { stagingApi } from "./staging";
import { statusApi } from "./status";
import type { ApplyLineRangeRequest } from "./types";

beforeEach(() => invokeMock.mockReset());

const request: ApplyLineRangeRequest = {
  file: "a.txt",
  staged: false,
  ranges: [
    {
      hunkIndex: 1,
      lineStart: 3,
      expected: [{ kind: "del", oldNo: 15, newNo: null, content: "l15" }],
    },
  ],
};

describe("line-range wrappers", () => {
  it("stages a range through apply_line_range", async () => {
    invokeMock.mockResolvedValue("Staged lines in a.txt");
    await expect(stagingApi.applyLineRange("/r", request)).resolves.toBe("Staged lines in a.txt");
    expect(invokeMock).toHaveBeenCalledWith("apply_line_range", { path: "/r", request });
  });

  it("reverts a range through revert_line_range", async () => {
    invokeMock.mockResolvedValue("Reverted lines in a.txt");
    await stagingApi.revertLineRange("/r", request);
    expect(invokeMock).toHaveBeenCalledWith("revert_line_range", { path: "/r", request });
  });

  it("rejects a misspelled range field before invoke", async () => {
    const bad = {
      ...request,
      ranges: [{ ...request.ranges[0], lineStrat: 3 }],
    } as unknown as ApplyLineRangeRequest;
    await expect(stagingApi.applyLineRange("/r", bad)).rejects.toThrow(/lineStrat/);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("workingFileDifferences", () => {
  it("parses the differences read", async () => {
    invokeMock.mockResolvedValue({
      diff: { path: "a.txt", status: "M", add: 1, del: 1, binary: false, hunks: [], truncated: false },
      differences: [
        { hunkIndex: 0, lineStart: 3, lineEnd: 4, inclusion: "excluded", stage: request.ranges, unstage: [] },
      ],
      wholeFile: true,
    });
    const result = await statusApi.workingFileDifferences("/r", "a.txt", true);
    expect(invokeMock).toHaveBeenCalledWith("working_file_differences", { path: "/r", file: "a.txt", wholeFile: true });
    expect(result.differences[0].inclusion).toBe("excluded");
  });
});
