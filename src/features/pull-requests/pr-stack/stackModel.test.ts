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

  describe("blockReason — a stack merge is all-or-nothing", () => {
    it("is false when every layer in the merge set can merge", () => {
      expect(stackView(three, 32).blockReason).toBeNull();
    });

    it("blocks on a draft, conflicting, or blocked layer below", () => {
      const draftBelow = stack([entry(1, 24, { isDraft: true }), entry(2, 30)]);
      expect(stackView(draftBelow, 30).blockReason).toBe("layer");

      const conflictBelow = stack([entry(1, 24, { mergeable: "CONFLICTING" }), entry(2, 30)]);
      expect(stackView(conflictBelow, 30).blockReason).toBe("layer");

      const blockedBelow = stack([entry(1, 24, { mergeState: "BLOCKED" }), entry(2, 30)]);
      expect(stackView(blockedBelow, 30).blockReason).toBe("layer");
    });

    it("blocks when the VIEWED pull request itself cannot merge", () => {
      // The regression seen on #309: the layer below was clean, but the PR being
      // viewed was BLOCKED, and the card still offered "Merge stack".
      const selfBlocked = stack([entry(1, 24), entry(2, 30, { mergeState: "BLOCKED" })]);
      expect(stackView(selfBlocked, 30).blockReason).toBe("layer");
    });

    it("ignores a blocked layer ABOVE — it isn't part of this merge", () => {
      const draftAbove = stack([entry(1, 24), entry(2, 30, { isDraft: true })]);
      expect(stackView(draftAbove, 24).blockReason).toBeNull();

      const blockedAbove = stack([entry(1, 24), entry(2, 30, { mergeState: "BLOCKED" })]);
      expect(stackView(blockedAbove, 24).blockReason).toBeNull();
    });

    it("does not treat an already-merged layer below as a blocker", () => {
      // The stack merge only lands unmerged layers, so a merged one is fine.
      const mergedBelow = stack([entry(1, 24, { state: "MERGED" }), entry(2, 30)]);
      expect(stackView(mergedBelow, 30).blockReason).toBeNull();
    });

    it("refuses to merge a stack whose layers aren't all visible", () => {
      // All-or-nothing: an unseen layer could be blocked, so offering the merge
      // would promise an outcome we can't see. Reported separately from
      // "layer" because the honest wording differs.
      const hidden = stack([entry(1, 24), entry(2, 30)], { size: 5 });
      expect(stackView(hidden, 30).blockReason).toBe("partial");
    });

    it("refuses when the viewed PR isn't among the layers received", () => {
      // Its own entry was filtered out, so these are somebody else's layers —
      // rendering them with a zero-count merge control would be nonsense.
      const view = stackView(three, 999);
      // `currentFound` alone gates the card — it returns null, so no headline or
      // merge control is ever derived from this view.
      expect(view.currentFound).toBe(false);
      expect(view.mergeCount).toBe(0);
    });

    it("won't enable a merge while GitHub is still computing a layer's state", () => {
      // UNKNOWN stays "ready" in the pill (calling it Not ready would be a
      // guess) but must not arm an irreversible action — GitHub disables its
      // own button here too.
      const computing = stack([entry(1, 24, { mergeState: "UNKNOWN" }), entry(2, 30)]);
      expect(stackView(computing, 30).rows.map((r) => r.status)).toEqual(["ready", "ready"]);
      expect(stackView(computing, 30).blockReason).toBe("unknown");
    });

    it("reports a real blocked layer ahead of an indeterminate one", () => {
      const both = stack([
        entry(1, 20, { mergeState: "UNKNOWN" }),
        entry(2, 24, { mergeState: "BLOCKED" }),
        entry(3, 30),
      ]);
      expect(stackView(both, 30).blockReason).toBe("layer");
    });

    it("ignores an indeterminate layer that already merged", () => {
      const landed = stack([entry(1, 24, { state: "MERGED", mergeState: "UNKNOWN" }), entry(2, 30)]);
      expect(stackView(landed, 30).blockReason).toBeNull();
    });

    it("reports a real blocked layer ahead of a partial stack", () => {
      // Both true → the actionable reason wins.
      const both = stack([entry(1, 24, { mergeState: "BLOCKED" }), entry(2, 30)], { size: 9 });
      expect(stackView(both, 30).blockReason).toBe("layer");
    });
  });

  describe("counts only the layers a merge actually lands", () => {
    it("excludes an already-merged or closed layer below", () => {
      // Counting them overstates "will also merge N pull requests below it".
      const withLanded = stack([
        entry(1, 20, { state: "MERGED" }),
        entry(2, 24, { state: "CLOSED" }),
        entry(3, 30),
        entry(4, 32),
      ]);
      // Viewed from the top (#32), only #30 is still landable below it.
      expect(stackView(withLanded, 32)).toMatchObject({ belowCount: 1, mergeCount: 2 });
    });

    it("counts every unmerged layer below when none have landed", () => {
      expect(stackView(three, 32)).toMatchObject({ belowCount: 2, mergeCount: 3 });
    });
  });

  it("flags a stack whose reported size exceeds the layers received", () => {
    expect(stackView(stack([entry(1, 24)], { size: 4 }), 24).partial).toBe(true);
    expect(stackView(three, 32).partial).toBe(false);
  });
});
