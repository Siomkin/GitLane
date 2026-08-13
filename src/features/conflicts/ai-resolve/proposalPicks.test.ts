import { describe, expect, it } from "vitest";

import { alignProposal, picksForHunk } from "./proposalPicks";

const ONE = ["head", "<<<<<<< HEAD", "a1", "a2", "=======", "b1", ">>>>>>> x", "tail", ""].join("\n");

/** The whole-file mapping the workspace does hunk by hunk, for the assertions. */
const picksForProposal = (conflicted: string, proposal: string) => {
  const hunks = alignProposal(conflicted, proposal);
  if (!hunks) return null;
  const out: Record<number, Set<string>> = {};
  for (const hunk of hunks) {
    const picks = picksForHunk(hunk);
    if (!picks) return null;
    out[hunk.idx] = picks;
  }
  return out;
};

describe("proposal alignment", () => {
  it("maps a side-taking proposal onto the hunk's ticks", () => {
    expect(picksForProposal(ONE, "head\nb1\ntail\n")).toEqual({ 1: new Set(["b:0"]) });
    expect(picksForProposal(ONE, "head\na1\na2\ntail\n")).toEqual({ 1: new Set(["a:0", "a:1"]) });
    expect(picksForProposal(ONE, "head\na1\na2\nb1\ntail\n")).toEqual({
      1: new Set(["a:0", "a:1", "b:0"]),
    });
  });

  it("fails closed on anything the ticks cannot express", () => {
    // A rewrite: lines that exist in neither side.
    expect(picksForProposal(ONE, "head\nmerged\ntail\n")).toBeNull();
    // Both sides dropped — an empty pick reads as "undecided", not a decision.
    expect(picksForProposal(ONE, "head\ntail\n")).toBeNull();
    // Reformatted context breaks the anchoring.
    expect(picksForProposal(ONE, "HEAD\nb1\ntail\n")).toBeNull();
    // Content added outside the conflict.
    expect(picksForProposal(ONE, "extra\nhead\nb1\ntail\n")).toBeNull();
    expect(picksForProposal(ONE, "head\nb1\ntail\nextra\n")).toBeNull();
  });

  it("maps every hunk of a multi-conflict file", () => {
    const two = [
      "top",
      "<<<<<<< HEAD",
      "a1",
      "=======",
      "b1",
      ">>>>>>> x",
      "mid",
      "<<<<<<< HEAD",
      "a2",
      "=======",
      "b2",
      ">>>>>>> x",
      "end",
      "",
    ].join("\n");

    expect(picksForProposal(two, "top\na1\nmid\nb2\nend\n")).toEqual({
      1: new Set(["a:0"]),
      3: new Set(["b:0"]),
    });
    // One rewritten hunk poisons the whole mapping — no half-applied picks.
    expect(picksForProposal(two, "top\nnew\nmid\nb2\nend\n")).toBeNull();
  });

  it("reports each hunk's verdict for review", () => {
    expect(alignProposal(ONE, "head\nb1\ntail\n")).toEqual([
      { idx: 1, ours: ["a1", "a2"], theirs: ["b1"], ai: ["b1"], verdict: "theirs" },
    ]);
    expect(alignProposal(ONE, "head\nmerged\ntail\n")?.[0].verdict).toBe("rewrote");
    expect(alignProposal(ONE, "head\ntail\n")?.[0].verdict).toBe("dropped");
    // A rewrite still aligns (it is reviewable) — it just cannot be ticked.
    expect(picksForProposal(ONE, "head\nmerged\ntail\n")).toBeNull();
  });
});
