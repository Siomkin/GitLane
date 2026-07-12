import { describe, it, expect } from "vitest";
import type { ReviewThread } from "@/lib/api";
import { reviewThreadsModel } from "./reviewThreadsModel";

const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "T_1",
  path: "src/a.ts",
  line: 10,
  isResolved: false,
  isOutdated: false,
  commentsTruncated: false,
  comments: [],
  ...over,
});

describe("reviewThreadsModel", () => {
  it("returns an empty model for no threads (nothing hidden)", () => {
    const m = reviewThreadsModel([], true);
    expect(m).toEqual({ total: 0, resolvedCount: 0, allHidden: true, byFile: [] });
    // Note: allHidden is only consulted after the component's threads.length
    // guard, so the empty case never renders the "all resolved" card.
  });

  it("hides resolved threads when hideResolved is on, keeps counts over ALL threads", () => {
    const threads = [
      thread({ id: "T_1" }),
      thread({ id: "T_2", isResolved: true }),
      thread({ id: "T_3", path: "src/b.ts" }),
    ];
    const m = reviewThreadsModel(threads, true);

    expect(m.total).toBe(3);
    expect(m.resolvedCount).toBe(1);
    expect(m.allHidden).toBe(false);
    expect(m.byFile.flatMap((g) => g.threads.map((t) => t.id))).toEqual(["T_1", "T_3"]);
  });

  it("shows resolved threads too when hideResolved is off", () => {
    const threads = [thread({ id: "T_1" }), thread({ id: "T_2", isResolved: true })];
    const m = reviewThreadsModel(threads, false);

    expect(m.byFile).toHaveLength(1);
    expect(m.byFile[0].threads.map((t) => t.id)).toEqual(["T_1", "T_2"]);
    expect(m.allHidden).toBe(false);
  });

  it("reports allHidden when every thread is resolved and hiding is on", () => {
    const threads = [
      thread({ id: "T_1", isResolved: true }),
      thread({ id: "T_2", isResolved: true }),
    ];
    expect(reviewThreadsModel(threads, true)).toMatchObject({
      total: 2,
      resolvedCount: 2,
      allHidden: true,
      byFile: [],
    });
    // Toggling the filter brings them back.
    expect(reviewThreadsModel(threads, false).allHidden).toBe(false);
  });

  it("groups by file in first-seen order, threads in list order within a group", () => {
    const threads = [
      thread({ id: "T_1", path: "src/b.ts" }),
      thread({ id: "T_2", path: "src/a.ts" }),
      thread({ id: "T_3", path: "src/b.ts" }),
    ];
    const m = reviewThreadsModel(threads, true);

    expect(m.byFile.map((g) => g.path)).toEqual(["src/b.ts", "src/a.ts"]);
    expect(m.byFile[0].threads.map((t) => t.id)).toEqual(["T_1", "T_3"]);
    expect(m.byFile[1].threads.map((t) => t.id)).toEqual(["T_2"]);
  });

  it("drops a file group entirely when hiding leaves it empty (first-seen order recomputed)", () => {
    const threads = [
      thread({ id: "T_1", path: "src/b.ts", isResolved: true }),
      thread({ id: "T_2", path: "src/a.ts" }),
    ];
    const m = reviewThreadsModel(threads, true);
    expect(m.byFile.map((g) => g.path)).toEqual(["src/a.ts"]);
  });
});
