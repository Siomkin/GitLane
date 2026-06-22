import { describe, expect, it } from "vitest";
import { segmentIntersectsViewport } from "./graphViewport";

describe("segmentIntersectsViewport", () => {
  it("keeps crossing edges and rejects edges wholly outside the canvas", () => {
    expect(segmentIntersectsViewport(20, 500, 100, 200)).toBe(true);
    expect(segmentIntersectsViewport(320, 500, 100, 200)).toBe(false);
    expect(segmentIntersectsViewport(0, 80, 100, 200)).toBe(false);
    expect(segmentIntersectsViewport(80, 90, 100, 200, 12)).toBe(true);
  });
});
