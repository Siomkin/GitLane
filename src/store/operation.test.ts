import { describe, expect, it } from "vitest";
import { mergeOperationStatus, operationLabel } from "./operation";
import type { OperationState } from "./repoTypes";
import type { OperationStatus } from "@/lib/api";

const status = (over: Partial<OperationStatus> = {}): OperationStatus => ({
  kind: "merge",
  canSkip: false,
  conflicts: [],
  advisory: "",
  ...over,
});

const conflict = (path: string, kind: "text" | "binary" | "deleted" = "text") => ({
  path,
  kind,
  deletedSide: "" as const,
});

describe("mergeOperationStatus", () => {
  it("returns null when no operation is active", () => {
    expect(mergeOperationStatus(null, status({ kind: "none" }))).toBeNull();
  });

  it("builds the initial union from the reported conflicts", () => {
    const result = mergeOperationStatus(
      null,
      status({ conflicts: [conflict("a.ts"), conflict("b.ts")] }),
    );
    expect(result?.kind).toBe("merge");
    expect(result?.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(result?.files.every((f) => !f.resolved)).toBe(true);
  });

  it("marks a no-longer-reported file resolved but keeps it in the union", () => {
    const first = mergeOperationStatus(
      null,
      status({ conflicts: [conflict("a.ts"), conflict("b.ts")] }),
    );
    // b.ts resolved → backend drops it from the conflict set.
    const next = mergeOperationStatus(first, status({ conflicts: [conflict("a.ts")] }));
    expect(next?.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(next?.files.find((f) => f.path === "a.ts")?.resolved).toBe(false);
    expect(next?.files.find((f) => f.path === "b.ts")?.resolved).toBe(true);
  });

  it("keeps file order stable and appends newly-surfaced conflicts", () => {
    const first = mergeOperationStatus(null, status({ conflicts: [conflict("a.ts")] }));
    const next = mergeOperationStatus(
      first,
      status({ conflicts: [conflict("a.ts"), conflict("c.ts")] }),
    );
    expect(next?.files.map((f) => f.path)).toEqual(["a.ts", "c.ts"]);
  });

  it("resets the union when the operation kind changes", () => {
    const merge: OperationState = {
      kind: "merge",
      canSkip: false,
      files: [{ path: "old.ts", kind: "text", deletedSide: "", resolved: true }],
    };
    const next = mergeOperationStatus(
      merge,
      status({ kind: "rebase", canSkip: true, conflicts: [conflict("new.ts")] }),
    );
    expect(next?.kind).toBe("rebase");
    expect(next?.canSkip).toBe(true);
    expect(next?.files.map((f) => f.path)).toEqual(["new.ts"]);
  });

  it("recognises the GL-74 carry kind and keeps it after conflicts clear", () => {
    const fresh = mergeOperationStatus(null, status({ kind: "carry", conflicts: [conflict("a.ts")] }));
    expect(fresh?.kind).toBe("carry");
    expect(fresh?.files.map((f) => f.path)).toEqual(["a.ts"]);
    // Staging the last carry conflict clears the index conflicts, but the backend
    // still reports "carry" while the recovery stashes live — the file flips to
    // resolved (so "Finish carry" stays enabled) instead of dropping the op (P1).
    const resolved = mergeOperationStatus(fresh, status({ kind: "carry", conflicts: [] }));
    expect(resolved?.kind).toBe("carry");
    expect(resolved?.files.find((f) => f.path === "a.ts")?.resolved).toBe(true);
  });
});

describe("operationLabel", () => {
  it("maps kinds to human verbs", () => {
    expect(operationLabel("merge")).toBe("Merge");
    expect(operationLabel("rebase")).toBe("Rebase");
    expect(operationLabel("cherry-pick")).toBe("Cherry-pick");
    expect(operationLabel("revert")).toBe("Revert");
    expect(operationLabel("carry")).toBe("Carry");
  });
});
