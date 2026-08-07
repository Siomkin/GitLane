import { describe, it, expect } from "vitest";
import { requestLease } from "./requestLease";

describe("requestLease", () => {
  it("keeps the lane with its most recent claimant", () => {
    const lane = requestLease();
    const first = lane.claim();
    expect(lane.isCurrent(first)).toBe(true);

    const second = lane.claim();
    // The overtaken request must publish nothing when it finally settles.
    expect(lane.isCurrent(first)).toBe(false);
    expect(lane.isCurrent(second)).toBe(true);
  });

  it("reads the holder without taking the lane", () => {
    const lane = requestLease();
    const held = lane.claim();
    expect(lane.current()).toBe(held);
    expect(lane.isCurrent(held)).toBe(true);
  });

  it("treats a never-claimed token as stale", () => {
    const lane = requestLease();
    // 0 is what `current()` reports before anything claims, so a caller that
    // captured it must not be mistaken for the holder of a later claim.
    const before = lane.current();
    lane.claim();
    expect(lane.isCurrent(before)).toBe(false);
  });

  it("gives each lane its own tokens", () => {
    const graph = requestLease();
    const worktrees = requestLease();
    const token = graph.claim();
    // A refresh in one lane must not invalidate an unrelated read in another.
    worktrees.claim();
    expect(graph.isCurrent(token)).toBe(true);
  });
});
