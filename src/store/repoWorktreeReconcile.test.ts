import { describe, expect, it } from "vitest";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import type { FileChange, OperationStatus, WorkingChanges } from "@/lib/api";
import type { OperationState } from "./repoTypes";
import { reconcileWorktreeState } from "./repoWorktreeReconcile";

const change = (path: string): FileChange => ({
  path,
  status: "M",
  add: 1,
  del: 0,
  binary: false,
});

const changes = (overrides: Partial<WorkingChanges> = {}): WorkingChanges => ({
  staged: [],
  unstaged: [],
  conflicted: [],
  advanced: emptyAdvancedState,
  ...overrides,
});

const status = (overrides: Partial<OperationStatus> = {}): OperationStatus => ({
  kind: "none",
  canSkip: false,
  conflicts: [],
  advisory: "",
  ...overrides,
});

const operation: OperationState = {
  kind: "rebase",
  canSkip: true,
  files: [{ path: "conflict.ts", kind: "text", deletedSide: "", resolved: false }],
};

describe("reconcileWorktreeState", () => {
  it("clears a vanished working-file selection and a clean WIP selection", () => {
    const fresh = changes();
    const result = reconcileWorktreeState({
      changes: fresh,
      opStatus: status(),
      operation,
      operationAdvisory: "bisect",
      selectedFile: { path: "gone.ts", source: "unstaged" },
      wipSelected: true,
    });

    expect(result.selectedFileGone).toBe(true);
    expect(result.noWip).toBe(true);
    expect(result.patch).toMatchObject({
      changes: fresh,
      operation: null,
      operationAdvisory: null,
      selectedFile: null,
      fileDiff: null,
      wipSelected: false,
    });
    expect(result.patch.changes).toBe(fresh);
  });

  it("preserves a WIP selection while working-tree changes remain", () => {
    const result = reconcileWorktreeState({
      changes: changes({ unstaged: [change("work.ts")] }),
      opStatus: status(),
      operation: null,
      operationAdvisory: null,
      selectedFile: null,
      wipSelected: true,
    });

    expect(result.noWip).toBe(false);
    expect(result.patch).not.toHaveProperty("wipSelected");
  });

  it("keeps live staged, unstaged, and commit-source selections", () => {
    const fresh = changes({ staged: [change("staged.ts")], unstaged: [change("work.ts")] });

    for (const selectedFile of [
      { path: "staged.ts", source: "staged" as const },
      { path: "work.ts", source: "unstaged" as const },
      { path: "not-in-worktree.ts", source: "commit" as const },
    ]) {
      const result = reconcileWorktreeState({
        changes: fresh,
        opStatus: status(),
        operation: null,
        operationAdvisory: null,
        selectedFile,
        wipSelected: false,
      });

      expect(result.selectedFileGone).toBe(false);
      expect(result.patch).not.toHaveProperty("selectedFile");
      expect(result.patch).not.toHaveProperty("fileDiff");
    }
  });

  it("merges a fresh operation status and publishes its advisory", () => {
    const result = reconcileWorktreeState({
      changes: changes({ conflicted: [change("next.ts")] }),
      opStatus: status({
        kind: "rebase",
        canSkip: true,
        advisory: "apply-mailbox",
        conflicts: [{ path: "next.ts", kind: "text", deletedSide: "" }],
      }),
      operation,
      operationAdvisory: "bisect",
      selectedFile: null,
      wipSelected: false,
    });

    expect(result.patch.operation).toMatchObject({
      kind: "rebase",
      canSkip: true,
      files: [
        { path: "conflict.ts", resolved: true },
        { path: "next.ts", resolved: false },
      ],
    });
    expect(result.patch.operationAdvisory).toBe("apply-mailbox");
    expect(result.noWip).toBe(false);
  });

  it("preserves stale operation state on status failure only while conflicts remain", () => {
    const conflicted = reconcileWorktreeState({
      changes: changes({ conflicted: [change("conflict.ts")] }),
      opStatus: null,
      operation,
      operationAdvisory: "bisect",
      selectedFile: null,
      wipSelected: false,
    });
    expect(conflicted.patch.operation).toBe(operation);
    expect(conflicted.patch.operationAdvisory).toBe("bisect");

    const clean = reconcileWorktreeState({
      changes: changes(),
      opStatus: null,
      operation,
      operationAdvisory: "bisect",
      selectedFile: null,
      wipSelected: false,
    });
    expect(clean.patch.operation).toBeNull();
    expect(clean.patch.operationAdvisory).toBe("bisect");
  });
});
