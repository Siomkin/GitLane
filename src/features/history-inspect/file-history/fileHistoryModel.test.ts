import { describe, expect, it } from "vitest";
import type { FileHistoryEntry } from "@/lib/api";
import { deletedEntry, revisionCountLabel, selectedEntry } from "./fileHistoryModel";

const entry = (over: Partial<FileHistoryEntry> = {}): FileHistoryEntry => ({
  oid: "aaaa111",
  shortOid: "aaaa111",
  subject: "feat: change",
  body: "",
  authorName: "Ada",
  authorEmail: "ada@example.test",
  timestamp: 1,
  status: "M",
  path: "src/app.ts",
  add: 1,
  del: 0,
  previousPath: null,
  ...over,
});

describe("fileHistoryModel", () => {
  it("finds the selected entry by oid, null when unselected or missing", () => {
    const entries = [entry(), entry({ oid: "bbbb222" })];
    expect(selectedEntry(entries, "bbbb222")?.oid).toBe("bbbb222");
    expect(selectedEntry(entries, null)).toBeNull();
    expect(selectedEntry(entries, "missing")).toBeNull();
  });

  it("finds the deletion marker only when a D revision exists", () => {
    expect(deletedEntry([entry()])).toBeNull();
    expect(deletedEntry([entry(), entry({ oid: "dead", status: "D" })])?.oid).toBe("dead");
  });

  it("labels the revision count: hidden while loading, N+ when truncated", () => {
    expect(revisionCountLabel(0, false, false)).toBe("0");
    expect(revisionCountLabel(5, false, false)).toBe("5");
    expect(revisionCountLabel(5, true, false)).toBe("5+");
    expect(revisionCountLabel(5, true, true)).toBe("");
  });
});
