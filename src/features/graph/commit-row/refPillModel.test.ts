import { describe, it, expect } from "vitest";
import type { RefLabel } from "@/lib/api";
import { combinedRefPillModel, refPillModel } from "./refPillModel";

const ref = (kind: RefLabel["kind"], name = "feature"): RefLabel => ({ name, kind });

describe("refPillModel", () => {
  it("covers the kind → icon/drag matrix", () => {
    // [kind, current, worktree, expected icon, dragKind]
    const matrix = [
      [ref("branch", "main"), true, null, "current", "local"],
      [ref("branch"), false, null, "branch", "local"],
      [ref("branch"), false, "wt", "worktree", "local"],
      [ref("remote", "origin/feature"), false, null, "remote", "remote"],
      [ref("tag", "v1.0"), false, null, "tag", null],
    ] as const;

    for (const [label, current, wt, icon, dragKind] of matrix) {
      const m = refPillModel(label, current, wt);
      expect(m.icon).toBe(icon);
      expect(m.dragKind).toBe(dragKind);
    }
  });

  it("lets current beat the worktree glyph — the checkmark is the stronger signal", () => {
    expect(refPillModel(ref("branch", "main"), true, "wt").icon).toBe("current");
  });

  it("carries the worktree tooltip only when the branch lives elsewhere", () => {
    expect(refPillModel(ref("branch"), false, "repo-feature").title).toBe(
      "Checked out in worktree: repo-feature",
    );
    expect(refPillModel(ref("branch"), false, null).title).toBeUndefined();
  });

  it("dots a branch whose other worktree is dirty, and says so in the tooltip", () => {
    const dirty = refPillModel(ref("branch"), false, "repo-feature", true);
    expect(dirty.dirty).toBe(true);
    expect(dirty.title).toBe("Checked out in worktree: repo-feature — uncommitted changes");
    expect(refPillModel(ref("branch"), false, "repo-feature", false).dirty).toBe(false);
  });

  it("never dots a pill that isn't standing in for another worktree", () => {
    // `worktreeDirty` describes that worktree, so with no worktree there is
    // nothing for it to describe — the current branch's own uncommitted work is
    // the WIP row, and tags/remotes aren't checkouts at all.
    expect(refPillModel(ref("branch"), false, null, true).dirty).toBe(false);
    expect(refPillModel(ref("branch", "main"), true, "wt", true).dirty).toBe(false);
    expect(refPillModel(ref("tag", "v1"), false, "wt", true).dirty).toBe(false);
    expect(refPillModel(ref("remote", "origin/x"), false, "wt", true).dirty).toBe(false);
  });

  it("never leaks the worktree tooltip to current branches, tags, or remotes", () => {
    // In the app the hook's enabled-gate keeps worktreeName null for these;
    // the pure model must be safe for arbitrary callers too.
    expect(refPillModel(ref("branch", "main"), true, "wt").title).toBeUndefined();
    expect(refPillModel(ref("tag", "v1"), false, "wt").title).toBeUndefined();
    expect(refPillModel(ref("remote", "origin/x"), false, "wt").title).toBeUndefined();
  });

  it("reproduces the exact class strings the leaves used to build with cn()", () => {
    expect(refPillModel(ref("branch", "main"), true, null).className).toMatchInlineSnapshot(
      `"flex items-center gap-1 h-[22px] rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 select-none max-w-[220px] pl-1 pr-2 bg-[var(--accent)] text-white shadow-sm cursor-grab active:cursor-grabbing"`,
    );
    expect(refPillModel(ref("tag", "v1"), false, null).className).toMatchInlineSnapshot(
      `"flex items-center gap-1 h-[22px] rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 select-none max-w-[220px] pl-1.5 pr-2 bg-amber-50 dark:bg-amber-400/10 border border-amber-300/70 dark:border-amber-400/25 text-amber-700 dark:text-amber-300"`,
    );
    expect(refPillModel(ref("remote", "origin/x"), false, null).className).toMatchInlineSnapshot(
      `"flex items-center gap-1 h-[22px] rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 select-none max-w-[220px] pl-1.5 pr-2 bg-black/[0.04] dark:bg-white/[0.05] border border-black/[0.06] dark:border-white/[0.06] text-neutral-500 dark:text-neutral-400 cursor-grab active:cursor-grabbing"`,
    );
    expect(refPillModel(ref("branch"), false, null).className).toMatchInlineSnapshot(
      `"flex items-center gap-1 h-[22px] rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 select-none max-w-[220px] pl-1.5 pr-2 bg-white dark:bg-neutral-700 border border-black/10 dark:border-white/10 text-neutral-700 dark:text-neutral-200 shadow-sm cursor-grab active:cursor-grabbing"`,
    );
  });

  it("applies the tone variants: accent for current, amber for tags, muted for remotes", () => {
    expect(refPillModel(ref("branch", "main"), true, null).className).toContain("bg-[var(--accent)]");
    expect(refPillModel(ref("tag", "v1"), false, null).className).toContain("bg-amber-50");
    expect(refPillModel(ref("remote", "origin/x"), false, null).className).toContain("text-neutral-500");
    expect(refPillModel(ref("branch"), false, null).className).toContain("bg-white");
  });

  it("only draggable pills get the grab cursor", () => {
    expect(refPillModel(ref("tag", "v1"), false, null).className).not.toContain("cursor-grab");
    expect(refPillModel(ref("branch"), false, null).className).toContain("cursor-grab");
    expect(refPillModel(ref("remote", "origin/x"), false, null).className).toContain("cursor-grab");
  });
});

describe("combinedRefPillModel", () => {
  it("follows the LOCAL branch's state for the glyph", () => {
    expect(combinedRefPillModel("main", 1, true, null).icon).toBe("current");
    expect(combinedRefPillModel("feature", 1, false, "wt").icon).toBe("worktree");
    expect(combinedRefPillModel("feature", 1, false, null).icon).toBe("branch");
    // Current beats the worktree glyph, mirroring the single pill.
    expect(combinedRefPillModel("main", 1, true, "wt").icon).toBe("current");
  });

  it("pluralizes the remote chip label and threads it into the split tooltip", () => {
    const one = combinedRefPillModel("main", 1, false, null);
    expect(one.remoteLabel).toBe("1 remote");
    expect(one.title).toBe("main — local + 1 remote in sync (click to split)");

    const two = combinedRefPillModel("main", 2, false, null);
    expect(two.remoteLabel).toBe("2 remotes");
    expect(two.title).toBe("main — local + 2 remotes in sync (click to split)");
  });

  it("dots the collapsed pill for a dirty other worktree, naming it in the tooltip", () => {
    const dirty = combinedRefPillModel("feature", 1, false, "repo-feature", true);
    expect(dirty.dirty).toBe(true);
    expect(dirty.title).toBe(
      "feature — local + 1 remote in sync (click to split), checked out in worktree: repo-feature — uncommitted changes",
    );
    const clean = combinedRefPillModel("feature", 1, false, "repo-feature", false);
    expect(clean.dirty).toBe(false);
    expect(clean.title).toBe(
      "feature — local + 1 remote in sync (click to split), checked out in worktree: repo-feature",
    );
    // Current is the open worktree — its WIP row owns that story.
    expect(combinedRefPillModel("main", 1, true, "wt", true).dirty).toBe(false);
    expect(combinedRefPillModel("feature", 1, false, null, true).dirty).toBe(false);
  });

  it("styles current with the accent and everything else as a plain card", () => {
    expect(combinedRefPillModel("main", 1, true, null).className).toMatchInlineSnapshot(
      `"flex items-center gap-1 h-[22px] rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 select-none max-w-[240px] cursor-grab active:cursor-grabbing pl-1 pr-1 bg-[var(--accent)] text-white shadow-sm"`,
    );
    expect(combinedRefPillModel("feature", 1, false, null).className).toMatchInlineSnapshot(
      `"flex items-center gap-1 h-[22px] rounded-md text-[11px] font-medium whitespace-nowrap shrink-0 select-none max-w-[240px] cursor-grab active:cursor-grabbing pl-1.5 pr-1 bg-white dark:bg-neutral-700 border border-black/10 dark:border-white/10 text-neutral-700 dark:text-neutral-200 shadow-sm"`,
    );
  });
});
