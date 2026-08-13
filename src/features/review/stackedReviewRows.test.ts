import { describe, expect, it } from "vitest";
import type { FileChange, FileDiff } from "@/lib/api";
import {
  buildStackedReviewModel,
  estimatedDiffBodySize,
  stackedFileAtViewportTop,
  stackedDiffKey,
} from "./stackedReviewRows";

const file = (path: string): FileChange => ({
  path,
  status: "M",
  add: 1,
  del: 0,
  binary: false,
});

const diff = (path: string, truncated = false): FileDiff => ({
  path,
  status: "M",
  add: 1,
  del: 0,
  binary: false,
  truncated,
  hunks: [
    {
      header: "@@ -1 +1 @@",
      lines: [{ kind: "add", oldNo: null, newNo: 1, content: path }],
    },
  ],
});

describe("buildStackedReviewModel", () => {
  it("flattens loaded files while keeping collapsed files header-only", () => {
    const files = [file("src/open.ts"), file("src/closed.ts")];
    const model = buildStackedReviewModel(
      files,
      { "src/closed.ts": true },
      { "src/open.ts": diff("src/open.ts", true) },
      new Set(),
    );

    expect(model.rows.map((row) => row.kind)).toEqual([
      "file-header",
      "hunk",
      "line",
      "truncated",
      "file-header",
    ]);
    expect(model.headerIndexByPath.get("src/open.ts")).toBe(0);
    expect(model.headerIndexByPath.get("src/closed.ts")).toBe(4);
    expect(model.bodyRangeByPath.get("src/open.ts")).toEqual({ start: 1, end: 4 });
    expect(model.bodyRangeByPath.get("src/closed.ts")).toEqual({ start: 5, end: 5 });
    expect(model.linesByFile.get("src/open.ts")).toHaveLength(1);
    expect(model.linesByFile.has("src/closed.ts")).toBe(false);
  });

  it("represents an unfetched visible file with a stable loading row", () => {
    const model = buildStackedReviewModel([file("src/lazy.ts")], {}, {}, new Set());
    expect(model.rows.map((row) => row.kind)).toEqual([
      "file-header",
      "loading",
    ]);
    expect(model.rows[1].key).toBe("file:src/lazy.ts:src/lazy.ts:loading");
  });

  it("uses a separate cache identity for an explicitly requested full diff", () => {
    const fullFiles = new Set(["src/big.ts"]);
    expect(stackedDiffKey("src/big.ts", fullFiles)).toBe("src/big.ts:full");
    const model = buildStackedReviewModel(
      [file("src/big.ts")],
      {},
      { "src/big.ts:full": diff("src/big.ts") },
      fullFiles,
    );
    expect(model.rows.some((row) => row.kind === "line")).toBe(true);
  });

  it("preserves an evicted file's virtual height without retaining its lines", () => {
    const loaded = diff("src/visited.ts", true);
    const size = estimatedDiffBodySize(loaded);
    const model = buildStackedReviewModel(
      [file("src/visited.ts")],
      {},
      {},
      new Set(),
      { "src/visited.ts": size },
    );

    expect(model.rows[1]).toMatchObject({ kind: "placeholder", size });
    expect(model.linesByFile.has("src/visited.ts")).toBe(false);
  });

  it("derives compact file context only after the full header leaves the viewport", () => {
    const model = buildStackedReviewModel(
      [file("src/context.ts")],
      {},
      { "src/context.ts": diff("src/context.ts") },
      new Set(),
    );
    const virtualRows = [
      { index: 0, end: 44 },
      { index: 1, end: 80 },
      { index: 2, end: 102 },
    ];

    expect(stackedFileAtViewportTop(model, virtualRows, 20)).toBeNull();
    expect(stackedFileAtViewportTop(model, virtualRows, 50)?.path).toBe("src/context.ts");
  });
});
