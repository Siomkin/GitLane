// Lazy-load error isolation: a single PR's diff/checks/threads failure must stay
// scoped to that resource — it must NOT set the list-level `prError` (which
// blanks the sidebar) and must NOT clear the loaded PR list.
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the single IPC boundary inline (the canonical Vitest hoisted pattern) so
// the store's async loaders run headlessly and we can drive gh failures.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { usePulls } from "./pulls";
import { useRepo } from "./repo";
import { useAccounts } from "./accounts";
import type { RepoSummary } from "@/lib/api";

const SUMMARY: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: "abc",
  detached: false,
};

beforeEach(() => {
  invokeMock.mockReset();
  usePulls.getState().reset();
  useRepo.setState({ summary: SUMMARY });
  useAccounts.setState({ repoAccountId: null, repoAccountRef: null });
});

describe("pulls lazy-load error isolation", () => {
  it("scopes a diff failure to the PR without touching prError or the list", async () => {
    usePulls.setState({ pullRequests: [{ num: 7 } as never] });
    invokeMock.mockRejectedValueOnce("diff blew up");

    await usePulls.getState().loadPrDiff(7);

    const s = usePulls.getState();
    expect(s.prError).toBeNull(); // list error untouched → sidebar stays visible
    expect(s.pullRequests).toHaveLength(1); // list not cleared
    expect(s.prDiffError[7]).toContain("diff blew up");
    expect(s.prDiffs[7]).toBeUndefined();
  });

  it("scopes a threads failure the same way (auto-loaded, most visible)", async () => {
    invokeMock.mockRejectedValueOnce("threads blew up");

    await usePulls.getState().loadPrThreads(7);

    const s = usePulls.getState();
    expect(s.prError).toBeNull();
    expect(s.prThreadsError[7]).toContain("threads blew up");
  });

  it("clears the per-PR error and caches the result on a successful retry", async () => {
    invokeMock.mockRejectedValueOnce("checks blew up");
    await usePulls.getState().loadPrChecks(7);
    expect(usePulls.getState().prChecksError[7]).toBeDefined();

    invokeMock.mockResolvedValueOnce([{ name: "build", ok: true }]);
    await usePulls.getState().loadPrChecks(7, true);

    const s = usePulls.getState();
    expect(s.prChecksError[7]).toBeUndefined();
    expect(s.prChecks[7]).toEqual([{ name: "build", ok: true }]);
  });

  it("keeps one PR's error from leaking into another PR's tab", async () => {
    invokeMock.mockRejectedValueOnce("diff blew up");
    await usePulls.getState().loadPrDiff(7);

    invokeMock.mockResolvedValueOnce([]);
    await usePulls.getState().loadPrDiff(9);

    const s = usePulls.getState();
    expect(s.prDiffError[7]).toBeDefined();
    expect(s.prDiffError[9]).toBeUndefined();
    expect(s.prDiffs[9]).toEqual([]);
  });
});
