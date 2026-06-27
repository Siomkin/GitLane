import { describe, expect, it } from "vitest";
import type { FileDiff } from "../../lib/api";
import { hunkPatchUnavailableReason } from "./hunkActions";

const diff = (overrides: Partial<FileDiff> = {}): FileDiff => ({
  path: "src/app.ts",
  status: "M",
  add: 1,
  del: 1,
  binary: false,
  truncated: false,
  hunks: [{ header: "@@ -1,1 +1,1 @@", lines: [] }],
  ...overrides,
});

describe("hunkPatchUnavailableReason", () => {
  it("allows ordinary text hunks in staged and unstaged working diffs", () => {
    expect(hunkPatchUnavailableReason(diff(), "unstaged")).toBeNull();
    expect(hunkPatchUnavailableReason(diff(), "staged")).toBeNull();
  });

  it("blocks unsupported hunk patch sources", () => {
    expect(hunkPatchUnavailableReason(diff(), "commit")).toContain("Committed");
    expect(hunkPatchUnavailableReason(diff({ binary: true }), "unstaged")).toContain("Binary");
    expect(hunkPatchUnavailableReason(diff({ truncated: true }), "unstaged")).toContain("full diff");
    expect(hunkPatchUnavailableReason(diff({ status: "U" }), "unstaged")).toContain("Untracked");
    expect(hunkPatchUnavailableReason(diff({ status: "R" }), "staged")).toContain("Renamed");
  });
});
