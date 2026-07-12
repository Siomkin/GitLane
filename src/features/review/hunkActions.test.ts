import { describe, expect, it } from "vitest";
import type { FileDiff } from "@/lib/api";
import { hunkBody, hunkPatchUnavailableReason, lineStagePatchUnavailableReason } from "./hunkActions";

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

describe("lineStagePatchUnavailableReason", () => {
  it("allows lines in ordinary modified diffs", () => {
    expect(lineStagePatchUnavailableReason(diff(), "unstaged")).toBeNull();
    expect(lineStagePatchUnavailableReason(diff(), "staged")).toBeNull();
  });

  it("blocks whole-file add/delete diffs (they stage as a whole)", () => {
    expect(lineStagePatchUnavailableReason(diff({ status: "A" }), "staged")).toContain("Added/deleted");
    expect(lineStagePatchUnavailableReason(diff({ status: "D" }), "unstaged")).toContain("Added/deleted");
  });

  it("inherits every hunk-staging restriction", () => {
    expect(lineStagePatchUnavailableReason(diff({ binary: true }), "unstaged")).toContain("Binary");
    expect(lineStagePatchUnavailableReason(diff(), "commit")).toContain("Committed");
  });
});

describe("hunkBody", () => {
  it("renders one signed line per row, joined by newlines", () => {
    const body = hunkBody({
      header: "@@ -1,2 +1,2 @@",
      lines: [
        { kind: "ctx", oldNo: 1, newNo: 1, content: "a" },
        { kind: "del", oldNo: 2, newNo: null, content: "old" },
        { kind: "add", oldNo: null, newNo: 2, content: "new" },
      ],
    });
    expect(body).toBe(" a\n-old\n+new");
  });
});
