import { describe, it, expect } from "vitest";
import type { RefLabel } from "../../../lib/api";
import { combinedRefPillModel, refPillModel } from "./refPillModel";

const ref = (kind: RefLabel["kind"], name = "feature"): RefLabel => ({ name, kind });

describe("refPillModel", () => {
  it("covers the kind → icon/drag matrix", () => {
    // [kind, current, worktree, expected icon, draggable, dragKind]
    const matrix = [
      [ref("branch", "main"), true, null, "current", true, "local"],
      [ref("branch"), false, null, "branch", true, "local"],
      [ref("branch"), false, "wt", "worktree", true, "local"],
      [ref("remote", "origin/feature"), false, null, "remote", true, "remote"],
      [ref("tag", "v1.0"), false, null, "tag", false, null],
    ] as const;

    for (const [label, current, wt, icon, draggable, dragKind] of matrix) {
      const m = refPillModel(label, current, wt);
      expect(m.icon).toBe(icon);
      expect(m.draggable).toBe(draggable);
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

  it("styles current with the accent and everything else as a plain card", () => {
    expect(combinedRefPillModel("main", 1, true, null).className).toContain("bg-[var(--accent)]");
    expect(combinedRefPillModel("feature", 1, false, null).className).toContain("bg-white");
    // Collapsed pills always drag (they act as the local branch).
    expect(combinedRefPillModel("feature", 1, false, null).className).toContain("cursor-grab");
  });
});
