import { describe, it, expect } from "vitest";
import type { FileChange, WorkingChanges } from "./api";
import { changeTotal, summarizeChanges } from "./changeSummary";

const file = (path: string, status: FileChange["status"]): FileChange => ({
  path,
  status,
  add: 0,
  del: 0,
  binary: false,
});

const changes = (over: Partial<WorkingChanges>): WorkingChanges => ({
  staged: [],
  unstaged: [],
  conflicted: [],
  ...over,
});

describe("summarizeChanges", () => {
  it("buckets status letters into added / modified / deleted", () => {
    const summary = summarizeChanges(
      changes({
        staged: [file("new.ts", "A"), file("edit.ts", "M"), file("gone.ts", "D")],
        unstaged: [file("untracked.ts", "U")],
      }),
    );
    expect(summary).toEqual({ added: 2, modified: 1, deleted: 1, conflicted: 0 });
  });

  it("folds rename and typechange into modified", () => {
    const summary = summarizeChanges(changes({ staged: [file("a", "R"), file("c", "T")] }));
    expect(summary.modified).toBe(2);
  });

  it("counts a path changed in both index and worktree once", () => {
    const summary = summarizeChanges(
      changes({ staged: [file("dual.ts", "M")], unstaged: [file("dual.ts", "M")] }),
    );
    expect(summary).toEqual({ added: 0, modified: 1, deleted: 0, conflicted: 0 });
  });

  it("ranks a deletion above an add when one path carries both", () => {
    const summary = summarizeChanges(
      changes({ staged: [file("x", "A")], unstaged: [file("x", "D")] }),
    );
    expect(summary).toEqual({ added: 0, modified: 0, deleted: 1, conflicted: 0 });
  });

  it("counts conflicted paths from the conflicted list (status 'C', the real backend shape)", () => {
    const summary = summarizeChanges(changes({ conflicted: [file("c.ts", "C")] }));
    expect(summary).toEqual({ added: 0, modified: 0, deleted: 0, conflicted: 1 });
  });

  it("conflicted outranks a stray duplicate entry for the same path", () => {
    const summary = summarizeChanges(
      changes({ unstaged: [file("c.ts", "M")], conflicted: [file("c.ts", "C")] }),
    );
    expect(summary).toEqual({ added: 0, modified: 0, deleted: 0, conflicted: 1 });
  });

  it("changeTotal sums every bucket", () => {
    expect(changeTotal({ added: 2, modified: 14, deleted: 1, conflicted: 0 })).toBe(17);
  });
});
