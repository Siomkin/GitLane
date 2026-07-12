// Pure review-row policy tests (GL-174): de-dup/source selection, stable
// ordering, and the within-snapshot cache key.
import { describe, expect, it } from "vitest";

import type { FileChange, WorkingChanges } from "@/lib/api";
import { deriveReviewRows, diffKey, rowPathsKey, KEY_SEP } from "./changesReviewModel";

const file = (path: string, over: Partial<FileChange> = {}): FileChange => ({
  path,
  status: "M",
  add: 1,
  del: 0,
  binary: false,
  ...over,
});

const changes = (over: Partial<WorkingChanges>): WorkingChanges => ({
  staged: [],
  unstaged: [],
  conflicted: [],
  advanced: { sparse: false, submodules: [], lfsPatterns: [] } as never,
  ...over,
});

describe("deriveReviewRows", () => {
  it("collapses a file present in both lists to one unstaged-sourced row", () => {
    const rows = deriveReviewRows(
      changes({ staged: [file("a.ts", { add: 3 })], unstaged: [file("a.ts", { add: 1 })] }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("unstaged");
    expect(rows[0].file.add).toBe(1); // the working-tree entry is shown
  });

  it("marks a fully staged file with the staged source and entry", () => {
    const rows = deriveReviewRows(changes({ staged: [file("a.ts", { add: 3 })] }));
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("staged");
    expect(rows[0].file.add).toBe(3);
  });

  it("keeps alphabetical order stable while files move between lists", () => {
    const before = deriveReviewRows(
      changes({ unstaged: [file("b.ts"), file("a.ts"), file("c.ts")] }),
    );
    // Staging b.ts must not move its slot.
    const after = deriveReviewRows(
      changes({ staged: [file("b.ts")], unstaged: [file("a.ts"), file("c.ts")] }),
    );
    expect(before.map((r) => r.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(after.map((r) => r.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(after[1].source).toBe("staged");
  });
});

describe("diffKey", () => {
  it("distinguishes source, status, and counts within a snapshot", () => {
    const base = file("a.ts");
    expect(diffKey("unstaged", base)).not.toBe(diffKey("staged", base));
    expect(diffKey("unstaged", base)).not.toBe(diffKey("unstaged", file("a.ts", { status: "A" })));
    expect(diffKey("unstaged", base)).not.toBe(diffKey("unstaged", file("a.ts", { add: 2 })));
  });

  it("cannot distinguish same-count content changes — the documented limitation", () => {
    // This is WHY the cache resets per snapshot (GL-173): identical metadata,
    // possibly different content.
    expect(diffKey("unstaged", file("a.ts"))).toBe(diffKey("unstaged", file("a.ts")));
  });

  it("survives paths containing spaces (NUL separator, not whitespace)", () => {
    const spaced = diffKey("unstaged", file("dir name/a file.ts"));
    expect(spaced.split(KEY_SEP)).toHaveLength(5);
  });
});

describe("rowPathsKey", () => {
  it("joins row paths with the NUL separator and round-trips by split", () => {
    const rows = deriveReviewRows(changes({ unstaged: [file("b b.ts"), file("a.ts")] }));
    expect(rowPathsKey(rows).split(KEY_SEP)).toEqual(["a.ts", "b b.ts"]);
    expect(rowPathsKey([])).toBe("");
  });
});
