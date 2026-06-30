import { describe, it, expect } from "vitest";
import { reviewSurface } from "./reviewSurface";

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

  it("scopes working-tree files to their staged/unstaged source", () => {
    expect(reviewSurface({ source: "staged" }, null, null)).toBe("work:staged");
    expect(reviewSurface({ source: "unstaged" }, null, null)).toBe("work:unstaged");
    expect(reviewSurface(null, null, null)).toBe("work:unstaged");
  });
});
