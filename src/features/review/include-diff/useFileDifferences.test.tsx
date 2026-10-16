import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { WorkingChanges } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { useFileDifferences } from "./useFileDifferences";

const snapshot = (): WorkingChanges => ({ staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState });
const result = (add: number) => ({
  diff: { path: "a.ts", status: "M", add, del: 0, binary: false, hunks: [], truncated: false },
  differences: [],
  wholeFile: false,
});

beforeEach(() => invokeMock.mockReset());

describe("useFileDifferences", () => {
  it("loads the selected file and reloads on a new working-changes snapshot", async () => {
    invokeMock.mockResolvedValueOnce(result(1)).mockResolvedValueOnce(result(2));
    const { result: hook, rerender } = renderHook(
      ({ changes }) => useFileDifferences("/r", "a.ts", changes),
      { initialProps: { changes: snapshot() } },
    );
    await waitFor(() => expect(hook.current.data?.diff.add).toBe(1));
    expect(invokeMock).toHaveBeenCalledWith("working_file_differences", { path: "/r", file: "a.ts", wholeFile: false });

    rerender({ changes: snapshot() });
    expect(hook.current.loading).toBe(false);
    await waitFor(() => expect(hook.current.data?.diff.add).toBe(2));
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a failed read as an error", async () => {
    invokeMock.mockRejectedValueOnce("boom");
    const changes = snapshot();
    const { result: hook } = renderHook(() => useFileDifferences("/r", "a.ts", changes));
    await waitFor(() => expect(hook.current.error).toBe("boom"));
  });
});
