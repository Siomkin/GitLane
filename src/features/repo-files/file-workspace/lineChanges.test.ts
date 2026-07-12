import { describe, expect, it } from "vitest";
import { computeLineChanges, computeLineChangesText, countLines, LineChange } from "./lineChanges";

const L = (s: string) => s.split("\n");

describe("computeLineChanges", () => {
  it("marks nothing when the buffer equals the baseline", () => {
    const base = L("a\nb\nc");
    const { tags, deletedBefore, deletedAtEnd } = computeLineChanges(base, L("a\nb\nc"));
    expect(tags).toEqual([LineChange.None, LineChange.None, LineChange.None]);
    expect(deletedBefore.size).toBe(0);
    expect(deletedAtEnd).toBe(false);
  });

  it("returns no markers when there is no baseline", () => {
    const { tags, deletedBefore } = computeLineChanges(null, L("a\nb"));
    expect(tags).toEqual([LineChange.None, LineChange.None]);
    expect(deletedBefore.size).toBe(0);
  });

  it("flags a purely inserted line as added, not modified", () => {
    // a,b → a,NEW,b : the middle line is a pure insertion.
    const { tags, deletedBefore } = computeLineChanges(L("a\nb"), L("a\nNEW\nb"));
    expect(tags).toEqual([LineChange.None, LineChange.Added, LineChange.None]);
    expect(deletedBefore.size).toBe(0);
  });

  it("flags an in-place edit as modified (coalesced del+ins)", () => {
    const { tags, deletedBefore } = computeLineChanges(L("a\nb\nc"), L("a\nB!\nc"));
    expect(tags).toEqual([LineChange.None, LineChange.Modified, LineChange.None]);
    expect(deletedBefore.size).toBe(0);
  });

  it("records a deletion caret where a baseline line was removed", () => {
    // a,b,c → a,c : line "b" removed; caret sits before current index 1 ("c").
    const { tags, deletedBefore, deletedAtEnd } = computeLineChanges(L("a\nb\nc"), L("a\nc"));
    expect(tags).toEqual([LineChange.None, LineChange.None]);
    expect([...deletedBefore]).toEqual([1]);
    expect(deletedAtEnd).toBe(false);
  });

  it("flags a deletion at the very end", () => {
    const { deletedBefore, deletedAtEnd } = computeLineChanges(L("a\nb\nc"), L("a\nb"));
    expect(deletedAtEnd).toBe(true);
    expect(deletedBefore.size).toBe(0);
  });

  it("treats extra insertions beyond the replaced run as added", () => {
    // a → X,Y,Z : one line replaced by three. First is modified, rest added.
    const { tags } = computeLineChanges(L("a"), L("X\nY\nZ"));
    expect(tags).toEqual([LineChange.Modified, LineChange.Added, LineChange.Added]);
  });

  it("marks every line added when the baseline is empty-ish", () => {
    const { tags } = computeLineChanges(L(""), L("a\nb"));
    // "" is one empty baseline line; it pairs with the first current line
    // (modified) and the rest are additions — all are change markers, none None.
    expect(tags.every((t) => t !== LineChange.None)).toBe(true);
  });

  it("stays correct for an insertion at the top (no cascade)", () => {
    const { tags, deletedBefore } = computeLineChanges(L("a\nb\nc"), L("HEAD\na\nb\nc"));
    expect(tags).toEqual([LineChange.Added, LineChange.None, LineChange.None, LineChange.None]);
    expect(deletedBefore.size).toBe(0);
  });

  // Degenerate + boundary inputs: tags length must always equal cur.length and
  // never throw / loop (the Myers frontier must stay valid).
  it.each<[string, string[], string[]]>([
    ["empty vs empty", [], []],
    ["empty baseline", [], L("a\nb")],
    ["empty current", L("a\nb"), []],
    ["all different", L("a\nb\nc"), L("x\ny\nz")],
    ["trailing newline added", L("a"), L("a\n")],
    ["trailing newline removed", L("a\n"), L("a")],
    ["repeated lines", L("a\na\na"), L("a\na")],
  ])("stays consistent: %s", (_label, base, cur) => {
    const { tags } = computeLineChanges(base, cur);
    expect(tags).toHaveLength(cur.length);
    expect(tags.every((t) => Object.values(LineChange).includes(t))).toBe(true);
  });

  it("bails to no-markers on a huge high-edit-distance diff (memory budget)", () => {
    // Two 8k-line files with no common lines exceed the frontier memory budget,
    // so the diff bails cleanly to all-`none` rather than freezing.
    const base = Array.from({ length: 8000 }, (_, i) => `a${i}`);
    const cur = Array.from({ length: 8000 }, (_, i) => `b${i}`);
    const { tags, deletedBefore } = computeLineChanges(base, cur);
    expect(tags).toHaveLength(cur.length);
    expect(tags.every((t) => t === LineChange.None)).toBe(true);
    expect(deletedBefore.size).toBe(0);
  });
});

describe("countLines", () => {
  it("counts lines without splitting", () => {
    expect(countLines("")).toBe(1);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\nb\nc")).toBe(3);
    expect(countLines("a\n")).toBe(2);
  });
});

describe("computeLineChangesText", () => {
  it("returns no markers (right length) when there is no baseline", () => {
    const { tags } = computeLineChangesText(null, "a\nb\nc");
    expect(tags).toEqual([LineChange.None, LineChange.None, LineChange.None]);
  });

  it("classifies changes straight from text", () => {
    const { tags } = computeLineChangesText("a\nb\nc", "a\nB!\nc");
    expect(tags).toEqual([LineChange.None, LineChange.Modified, LineChange.None]);
  });

  it("skips the diff (all-none, correct length) for a newline-dense file over the cap", () => {
    // 20_001 lines on the current side — over MAX_DIFF_LINES; the diff must be
    // skipped and return one tag per current line, all None.
    const cur = "x\n".repeat(20_001); // 20_002 lines
    const { tags } = computeLineChangesText("a\nb", cur);
    expect(tags).toHaveLength(20_002);
    expect(tags.every((t) => t === LineChange.None)).toBe(true);
  });
});
