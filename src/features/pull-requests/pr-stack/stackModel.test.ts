import { describe, expect, it } from "vitest";
import type { PrStack, PrStackEntry } from "@/lib/api";
import { stackView } from "./stackModel";

const entry = (position: number, number: number, over: Partial<PrStackEntry> = {}): PrStackEntry => ({
  position,
  number,
  title: `layer ${position}`,
  state: "OPEN",
  isDraft: false,
  headRef: `branch-${position}`,
  mergeable: "MERGEABLE",
  ...over,
});

const stack = (entries: PrStackEntry[], over: Partial<PrStack> = {}): PrStack => ({
  number: 307,
  size: entries.length,
  baseRef: "latest",
  position: 1,
  entries,
  ...over,
});

describe("stackView", () => {
  const three = stack([entry(1, 24), entry(2, 30), entry(3, 32)]);

  it("renders top of the stack first", () => {
    expect(stackView(three, 32).rows.map((r) => r.entry.number)).toEqual([32, 30, 24]);
  });

  it("counts the layers a stack merge would also land", () => {
    // Top layer: everything below it comes along.
    expect(stackView(three, 32)).toMatchObject({ belowCount: 2, mergeCount: 3 });
    // Middle layer: only the one beneath it.
    expect(stackView(three, 30)).toMatchObject({ belowCount: 1, mergeCount: 2 });
    // Bottom layer merges alone.
    expect(stackView(three, 24)).toMatchObject({ belowCount: 0, mergeCount: 1 });
  });

  it("does not claim a merge count for a PR missing from the entries", () => {
    expect(stackView(three, 999)).toMatchObject({ belowCount: 0, mergeCount: 0 });
  });

  it("treats an indefinite mergeable verdict as ready, not conflicting", () => {
    // GitHub reports UNKNOWN until it computes mergeability; showing "Conflicts"
    // during that window would be wrong.
    const pending = stack([entry(1, 24, { mergeable: "UNKNOWN" }), entry(2, 30, { mergeable: "" })]);
    expect(pending.entries.length).toBe(2);
    expect(stackView(pending, 30).rows.map((r) => r.status)).toEqual(["ready", "ready"]);
  });

  it("ranks state above draft and conflicts", () => {
    const mixed = stack([
      entry(1, 24, { state: "MERGED", isDraft: true }),
      entry(2, 30, { isDraft: true, mergeable: "CONFLICTING" }),
      entry(3, 32, { mergeable: "CONFLICTING" }),
    ]);
    expect(stackView(mixed, 32).rows.map((r) => r.status)).toEqual(["conflicts", "draft", "merged"]);
  });

  describe("belowBlocked — a stack merge is all-or-nothing", () => {
    it("is false when every layer below can merge", () => {
      expect(stackView(three, 32).belowBlocked).toBe(false);
    });

    it("blocks on a draft or conflicting layer below", () => {
      const draftBelow = stack([entry(1, 24, { isDraft: true }), entry(2, 30)]);
      expect(stackView(draftBelow, 30).belowBlocked).toBe(true);

      const conflictBelow = stack([entry(1, 24, { mergeable: "CONFLICTING" }), entry(2, 30)]);
      expect(stackView(conflictBelow, 30).belowBlocked).toBe(true);
    });

    it("ignores a blocked layer ABOVE — it isn't part of this merge", () => {
      const draftAbove = stack([entry(1, 24), entry(2, 30, { isDraft: true })]);
      expect(stackView(draftAbove, 24).belowBlocked).toBe(false);
    });

    it("does not treat an already-merged layer below as a blocker", () => {
      // The stack merge only lands unmerged layers, so a merged one is fine.
      const mergedBelow = stack([entry(1, 24, { state: "MERGED" }), entry(2, 30)]);
      expect(stackView(mergedBelow, 30).belowBlocked).toBe(false);
    });
  });

  it("flags a stack whose reported size exceeds the layers received", () => {
    expect(stackView(stack([entry(1, 24)], { size: 4 }), 24).partial).toBe(true);
    expect(stackView(three, 32).partial).toBe(false);
  });
});
