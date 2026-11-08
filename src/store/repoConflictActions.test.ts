import { beforeEach, describe, expect, it, vi } from "vitest";

const abortOperation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { abortOperation }, toCommandError: (e: unknown) => e }));
vi.mock("./accounts", () => ({ useAccounts: { getState: () => ({}) } }));
vi.mock("./ui", () => ({ useUi: { getState: () => ({}) } }));
vi.mock("./repoWriteActions/shared", () => ({
  captureOwner: () => "owner",
  ownerIsCurrent: () => true,
  refreshSettled: async () => true,
}));

import { createRepoConflictActions } from "./repoConflictActions";
import type { RepoGet, RepoSet } from "./repoTypes";

const actionsFor = (kind: string) => {
  const state = { summary: { path: "/repo" }, operation: { kind } };
  return createRepoConflictActions((() => {}) as unknown as RepoSet, (() => state) as unknown as RepoGet);
};

describe("abortOperation", () => {
  beforeEach(() => abortOperation.mockReset().mockResolvedValue("saved to a backup stash"));

  it("returns the backend's result for a carry", async () => {
    await expect(actionsFor("carry").abortOperation()).resolves.toBe("saved to a backup stash");
  });

  it("keeps the generic message for other operations", async () => {
    await expect(actionsFor("merge").abortOperation()).resolves.toBe("Merge aborted");
  });
});
