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
  checks: "SUCCESS",
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
      entry(1, 24, { mergeable: "UNKNOWN" }),
      entry(2, 30, { mergeable: "" }),
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

  // Readiness is the head commit's check rollup — the signal GitHub's own stack
  // card renders from. NOT `mergeStateStatus`: that answers BLOCKED for anything
  // the base ruleset still wants, and four layers with every check green were
  // observed reporting BLOCKED while GitHub showed each one Ready.
  describe("readiness comes from the check rollup", () => {
    it("marks any non-green rollup as not ready", () => {
      for (const checks of ["PENDING", "FAILURE", "ERROR", "EXPECTED"] as const) {
        const layer = stack([entry(1, 24, { checks })]);
        expect(stackView(layer, 24).rows[0]?.status).toBe("blocked");
      }
    });

    it("is ready on SUCCESS, and on a repo that runs no checks at all", () => {
      expect(stackView(stack([entry(1, 24, { checks: "SUCCESS" })]), 24).rows[0]?.status).toBe(
        "ready",
      );
      // "" is "nothing failing", not "nothing known" — a repo without CI must
      // not have every layer stuck on Not ready.
      expect(stackView(stack([entry(1, 24, { checks: "" })]), 24).rows[0]?.status).toBe("ready");
    });

    it("stays ready when only the base ruleset is unsatisfied", () => {
      // The regression this replaces: an unapproved PR with green checks is
      // Ready on GitHub. Rules are enforced when the merge runs.
      const unapproved = stack([entry(1, 24), entry(2, 30)]);
      expect(stackView(unapproved, 30).rows.map((r) => r.status)).toEqual(["ready", "ready"]);
      expect(stackView(unapproved, 30).blockReason).toBeNull();
    });

    it("ranks conflicts above a failing rollup", () => {
      const both = stack([entry(1, 24, { mergeable: "CONFLICTING", checks: "FAILURE" })]);
      expect(stackView(both, 24).rows[0]?.status).toBe("conflicts");
    });
  });

  // A green layer above a red one merges cleanly into its own base, so GitHub's
  // per-PR signals say "ready" — the blocked-ness is a property of the chain.
  // Observed on stack #354: GitLane showed a green Ready on a PR GitHub marked
  // Blocked downstack.
  describe("blocked downstack — readiness accounts for the layers below", () => {
    it("never shows Ready above an unmergeable layer, and names the blocker", () => {
      const s = stack([
        entry(1, 10),
        entry(2, 20, { checks: "FAILURE" }),
        entry(3, 30, { checks: "FAILURE" }),
        entry(4, 40),
      ]);
      const rows = stackView(s, 40).rows;
      // Top-first: #40's own checks are green, but #20 and #30 below are red.
      expect(rows.map((r) => r.status)).toEqual(["blockedDownstack", "blocked", "blocked", "ready"]);
      // The lowest blocker is named — it is the one that must be fixed first.
      expect(rows[0]?.blockedBy).toBe(20);
    });

    it("blocks downstack on a draft or conflicting layer below, too", () => {
      const draft = stack([entry(1, 10, { isDraft: true }), entry(2, 20)]);
      expect(stackView(draft, 20).rows[0]).toMatchObject({ status: "blockedDownstack", blockedBy: 10 });
      const conflicts = stack([entry(1, 10, { mergeable: "CONFLICTING" }), entry(2, 20)]);
      expect(stackView(conflicts, 20).rows[0]).toMatchObject({ status: "blockedDownstack", blockedBy: 10 });
    });

    it("keeps a layer's own not-ready state — downstack never overrides it", () => {
      const s = stack([entry(1, 10, { checks: "FAILURE" }), entry(2, 20, { checks: "PENDING" })]);
      expect(stackView(s, 20).rows.map((r) => r.status)).toEqual(["blocked", "blocked"]);
    });

    it("ignores merged and closed layers below — they are not landed again", () => {
      const s = stack([
        entry(1, 10, { state: "MERGED", checks: "FAILURE" }),
        entry(2, 20, { state: "CLOSED", mergeable: "CONFLICTING" }),
        entry(3, 30),
      ]);
      expect(stackView(s, 30).rows[0]?.status).toBe("ready");
    });

    it("agrees with the merge control: a blocked-downstack view is not offered", () => {
      // The badge and the "Merge stack N" footer must not contradict each other.
      const s = stack([entry(1, 10, { checks: "FAILURE" }), entry(2, 20)]);
      expect(stackView(s, 20).blockReason).toBe("layer");
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

      const blockedBelow = stack([entry(1, 24, { checks: "FAILURE" }), entry(2, 30)]);
      expect(stackView(blockedBelow, 30).blockReason).toBe("layer");
    });

    it("blocks when the VIEWED pull request itself cannot merge", () => {
      // The regression seen on #309: the layer below was clean, but the PR being
      // viewed was BLOCKED, and the card still offered "Merge stack".
      const selfBlocked = stack([entry(1, 24), entry(2, 30, { checks: "FAILURE" })]);
      expect(stackView(selfBlocked, 30).blockReason).toBe("layer");
    });

    it("ignores a blocked layer ABOVE — it isn't part of this merge", () => {
      const draftAbove = stack([entry(1, 24), entry(2, 30, { isDraft: true })]);
      expect(stackView(draftAbove, 24).blockReason).toBeNull();

      const blockedAbove = stack([entry(1, 24), entry(2, 30, { checks: "FAILURE" })]);
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

    it("blocks while a layer's checks are still running", () => {
      const running = stack([entry(1, 24, { checks: "PENDING" }), entry(2, 30)]);
      expect(stackView(running, 30).blockReason).toBe("layer");
    });

    it("ignores a merged layer whose checks never went green", () => {
      // It is not landed again, so its rollup is irrelevant.
      const landed = stack([entry(1, 24, { state: "MERGED", checks: "PENDING" }), entry(2, 30)]);
      expect(stackView(landed, 30).blockReason).toBeNull();
    });

    it("reports a real blocked layer ahead of a partial stack", () => {
      // Both true → the actionable reason wins.
      const both = stack([entry(1, 24, { checks: "FAILURE" }), entry(2, 30)], { size: 9 });
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

  it("marks only the layers a live merge actually lands", () => {
    const terminal = stack([
      entry(1, 20, { state: "CLOSED" }),
      entry(2, 24, { state: "MERGED" }),
      entry(3, 30),
      entry(4, 32),
    ]);
    const rows = stackView(terminal, 32, true).rows;
    // Top-first: the two open layers land; the merged and closed ones below are
    // not landed again and keep their own terminal status.
    expect(rows.map((r) => r.status)).toEqual(["merging", "merging", "merged", "closed"]);
    // A layer above the viewed PR is outside the merge set and untouched.
    expect(stackView(three, 30, true).rows.map((r) => r.status)).toEqual([
      "ready",
      "merging",
      "merging",
    ]);
  });

  it("leaves the derived counts and block reason untouched while merging", () => {
    // The merging rows are written after the counts are derived from them, so a
    // reordering inside `stackView` would silently change what the card claims.
    const blocked = stack([entry(1, 24, { checks: "FAILURE" }), entry(2, 30), entry(3, 32)], {
      size: 5,
    });
    const still = stackView(blocked, 32);
    expect(stackView(blocked, 32, true)).toMatchObject({
      belowCount: still.belowCount,
      mergeCount: still.mergeCount,
      blockReason: still.blockReason,
      partial: still.partial,
    });
  });
});
