import { describe, it, expect } from "vitest";
import { reviewSurface, selectionSurface } from "./reviewSurface";

describe("reviewSurface", () => {
  it("scopes a single committed file to its commit", () => {
    expect(reviewSurface({ source: "commit" }, "abc123", null)).toBe("commit:abc123");
  });

  it("scopes a committed file in a multi-commit selection to the whole selection", () => {
    // Matches StackedReview's `selection:<oids>` key so comments don't collide
    // with a single-commit review of the focus commit.
    expect(reviewSurface({ source: "commit" }, "abc123", ["abc123", "def456"])).toBe(
      "selection:abc123,def456",
    );
  });

  it("keys the selection independent of commit order (notes survive a reorder)", () => {
    // A refresh re-publishes the same set focus-first; the surface must not change.
    const a = reviewSurface({ source: "commit" }, "x", ["abc123", "def456"]);
    const b = reviewSurface({ source: "commit" }, "x", ["def456", "abc123"]);
    expect(a).toBe(b);
    expect(a).toBe("selection:abc123,def456");
  });

  it("scopes working-tree files to their staged/unstaged source", () => {
    expect(reviewSurface({ source: "staged" }, null, null)).toBe("work:staged");
    expect(reviewSurface({ source: "unstaged" }, null, null)).toBe("work:unstaged");
    expect(reviewSurface(null, null, null)).toBe("work:unstaged");
  });
});

describe("selectionSurface", () => {
  it("is order-independent (any permutation of the same set is one key)", () => {
    const oids = ["def456", "abc123", "789aaa"];
    expect(selectionSurface(oids)).toBe("selection:789aaa,abc123,def456");
    expect(selectionSurface([...oids].reverse())).toBe(selectionSurface(oids));
  });

  it("byte-matches the single-file review's key for the same commit set", () => {
    // Both surfaces derive through the shared constructor, so a comment taken on
    // the merged per-file diff joins the identical stacked-review surface.
    const oids = ["def456", "abc123"];
    expect(reviewSurface({ source: "commit" }, "abc123", oids)).toBe(selectionSurface(oids));
    expect(selectionSurface(oids, null)).toBe(selectionSurface(oids));
    expect(selectionSurface(oids, "base1")).toBe("selection:abc123,def456:working:base1");
  });
});
