import { describe, expect, it } from "vitest";
import type { FileDiff } from "@/lib/api";
import { decodeBase64Text, previewSource } from "./preview";

const diff = (over: Partial<FileDiff>): FileDiff => ({
  path: "README.md",
  status: "M",
  add: 1,
  del: 1,
  binary: false,
  truncated: false,
  hunks: [],
  ...over,
});

describe("previewSource", () => {
  it("reads the working tree by path for an unstaged diff, even when libgit2 reported an oid", () => {
    // The worktree side's oid is a computed hash that may not exist in the ODB.
    expect(previewSource(diff({ newOid: "feed" }), "unstaged")).toEqual({ file: "README.md" });
    expect(previewSource(diff({ status: "U" }), "unstaged")).toEqual({ file: "README.md" });
  });

  it("reads the new-side blob by oid for staged and committed diffs", () => {
    expect(previewSource(diff({ newOid: "abc123" }), "staged")).toEqual({ oid: "abc123" });
    expect(previewSource(diff({ newOid: "abc123" }), "commit")).toEqual({ oid: "abc123" });
  });

  it("returns null when there is nothing to render", () => {
    expect(previewSource(diff({ status: "D", newOid: undefined }), "commit")).toBeNull();
    expect(previewSource(diff({ status: "D" }), "unstaged")).toBeNull();
    // A non-worktree diff without a new-side oid has no readable source.
    expect(previewSource(diff({ newOid: undefined }), "commit")).toBeNull();
  });
});

describe("decodeBase64Text", () => {
  it("decodes UTF-8 content, including non-ASCII", () => {
    const text = "# Заголовок\n\némoji 🎉\n";
    const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    expect(decodeBase64Text(base64)).toBe(text);
  });
});
