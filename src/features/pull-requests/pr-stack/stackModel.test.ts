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
  mergeState: "CLEAN",
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
    const pending = stack([
      entry(1, 24, { mergeable: "UNKNOWN", mergeState: "UNKNOWN" }),
      entry(2, 30, { mergeable: "", mergeState: "" }),
    ]);
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

  // The bug this file exists to prevent: `mergeable` reports CONFLICTS ONLY, so
  // a PR held by a required check or review is MERGEABLE + BLOCKED. Reading only
  // `mergeable` labelled such a layer "Ready" and offered a merge the API
  // refuses — which is exactly what GitHub's own card calls "Not ready".
  describe("readiness comes from mergeStateStatus, not mergeable", () => {
    it("marks a MERGEABLE but BLOCKED layer as not ready", () => {
      const blocked = stack([entry(1, 24), entry(2, 30, { mergeState: "BLOCKED" })]);
      expect(stackView(blocked, 30).rows.map((r) => r.status)).toEqual(["blocked", "ready"]);
    });

    it("treats BEHIND as not ready and DIRTY as conflicts", () => {
      const behind = stack([entry(1, 24, { mergeState: "BEHIND" })]);
      expect(stackView(behind, 24).rows[0]?.status).toBe("blocked");

      const dirty = stack([entry(1, 24, { mergeState: "DIRTY" })]);
      expect(stackView(dirty, 24).rows[0]?.status).toBe("conflicts");
    });

    it("keeps UNSTABLE and HAS_HOOKS mergeable", () => {
      // UNSTABLE = only non-required checks failing; GitHub still merges it.
      const unstable = stack([entry(1, 24, { mergeState: "UNSTABLE" })]);
      expect(stackView(unstable, 24).rows[0]?.status).toBe("ready");

      const hooks = stack([entry(1, 24, { mergeState: "HAS_HOOKS" })]);
      expect(stackView(hooks, 24).rows[0]?.status).toBe("ready");
    });
  });

  describe("mergeBlocked — a stack merge is all-or-nothing", () => {
    it("is false when every layer in the merge set can merge", () => {
      expect(stackView(three, 32).mergeBlocked).toBe(false);
    });

    it("blocks on a draft, conflicting, or blocked layer below", () => {
      const draftBelow = stack([entry(1, 24, { isDraft: true }), entry(2, 30)]);
      expect(stackView(draftBelow, 30).mergeBlocked).toBe(true);

      const conflictBelow = stack([entry(1, 24, { mergeable: "CONFLICTING" }), entry(2, 30)]);
      expect(stackView(conflictBelow, 30).mergeBlocked).toBe(true);

      const blockedBelow = stack([entry(1, 24, { mergeState: "BLOCKED" }), entry(2, 30)]);
      expect(stackView(blockedBelow, 30).mergeBlocked).toBe(true);
    });

    it("blocks when the VIEWED pull request itself cannot merge", () => {
      // The regression seen on #309: the layer below was clean, but the PR being
      // viewed was BLOCKED, and the card still offered "Merge stack".
      const selfBlocked = stack([entry(1, 24), entry(2, 30, { mergeState: "BLOCKED" })]);
      expect(stackView(selfBlocked, 30).mergeBlocked).toBe(true);
    });

    it("ignores a blocked layer ABOVE — it isn't part of this merge", () => {
      const draftAbove = stack([entry(1, 24), entry(2, 30, { isDraft: true })]);
      expect(stackView(draftAbove, 24).mergeBlocked).toBe(false);

      const blockedAbove = stack([entry(1, 24), entry(2, 30, { mergeState: "BLOCKED" })]);
      expect(stackView(blockedAbove, 24).mergeBlocked).toBe(false);
    });

    it("does not treat an already-merged layer below as a blocker", () => {
      // The stack merge only lands unmerged layers, so a merged one is fine.
      const mergedBelow = stack([entry(1, 24, { state: "MERGED" }), entry(2, 30)]);
      expect(stackView(mergedBelow, 30).mergeBlocked).toBe(false);
    });
  });

  it("flags a stack whose reported size exceeds the layers received", () => {
    expect(stackView(stack([entry(1, 24)], { size: 4 }), 24).partial).toBe(true);
    expect(stackView(three, 32).partial).toBe(false);
  });
});
