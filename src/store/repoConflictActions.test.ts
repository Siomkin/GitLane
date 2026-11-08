import { beforeEach, describe, expect, it, vi } from "vitest";

const abortOperation = vi.hoisted(() => vi.fn());
const continueOperation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
  api: { abortOperation, continueOperation },
  toCommandError: (e: unknown) => e,
}));
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
  const state = {
    summary: { path: "/repo" },
    operation: { kind, files: [{ path: "a.txt", resolved: false }] },
  };
  return createRepoConflictActions((() => {}) as unknown as RepoSet, (() => state) as unknown as RepoGet);
};

describe("abortOperation", () => {
  beforeEach(() => {
    abortOperation.mockReset().mockResolvedValue("saved to a backup stash");
  });

  it("returns the backend's result for a carry", async () => {
    await expect(actionsFor("carry").abortOperation()).resolves.toBe("saved to a backup stash");
  });

  it("keeps the generic message for other operations", async () => {
    await expect(actionsFor("merge").abortOperation()).resolves.toBe("Merge aborted");
  });

  it("rejects a failed abort even though conflicts remain", async () => {
    abortOperation.mockRejectedValue(new Error("backup failed"));
    await expect(actionsFor("carry").abortOperation()).rejects.toThrow("backup failed");
  });

  it("still reports a continue that stops on the next conflict as progress", async () => {
    continueOperation.mockRejectedValue(new Error("next conflict"));
    await expect(actionsFor("rebase").continueOperation()).resolves.toContain("next conflicts");
  });
});
