import { describe, expect, it } from "vitest";
import {
  KNOWN_COMMIT_AGENTS,
  type CommitCoAuthor,
  type CommitNodeIdentity,
} from "./commitAgents";
import { drawCommitNode, type CommitNodeBadge } from "./commitNodePainter";

function fakeContext() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const call = (name: string) => (...args: unknown[]) => calls.push({ name, args });
  const ctx = {
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    beginPath: call("beginPath"),
    arc: call("arc"),
    fill: call("fill"),
    stroke: call("stroke"),
    save: call("save"),
    restore: call("restore"),
    clip: call("clip"),
    fillRect: call("fillRect"),
    drawImage: call("drawImage"),
    fillText: call("fillText"),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const baseOptions = {
  x: 10,
  y: 20,
  outerRadius: 5,
  avatarRadius: 9,
  color: "#5b8def",
  surface: "#16181d",
  nodeStroke: "#15171c",
  headRing: "#e8ebf2",
  selectedRing: "#2f9e7e",
  nodeAlpha: 1,
  selected: false,
  merge: false,
  head: false,
  badge: null,
};

const human: CommitNodeIdentity = {
  kind: "human",
  initials: "AS",
  color: "#db4d8a",
  coAuthors: [],
};

function coAuthor(overrides: Partial<CommitCoAuthor> = {}): CommitCoAuthor {
  return {
    name: "Jonas Deri",
    email: "jonas@example.com",
    initials: "JD",
    color: "#e0843b",
    agent: null,
    ...overrides,
  };
}

describe("drawCommitNode", () => {
  it("keeps the preference-off path on the classic dot painter", () => {
    const { ctx, calls } = fakeContext();
    drawCommitNode({ ...baseOptions, ctx, identity: null, agentImage: null });

    expect(calls.filter((call) => call.name === "arc")[0]?.args[2]).toBe(5);
    expect(calls.some((call) => call.name === "drawImage")).toBe(false);
    expect(calls.some((call) => call.name === "fillText")).toBe(false);
    expect(calls.some((call) => call.name === "clip")).toBe(false);
  });

  it("paints the ringed identity avatar for a human author", () => {
    const { ctx, calls } = fakeContext();
    drawCommitNode({ ...baseOptions, ctx, identity: human, agentImage: null });

    // Lane ring → surface gap → identity fill, outermost first.
    const radii = calls
      .filter((call) => call.name === "arc")
      .map((call) => Number((call.args[2] as number).toFixed(2)));
    expect(radii).toEqual([11.2, 10.2, 9]);
    expect(calls.find((call) => call.name === "fillText")?.args[0]).toBe("AS");
    expect(calls.some((call) => call.name === "drawImage")).toBe(false);
  });

  it("clips and draws a ready bundled agent image", () => {
    const { ctx, calls } = fakeContext();
    const image = {} as HTMLImageElement;
    drawCommitNode({
      ...baseOptions,
      ctx,
      identity: { kind: "agent", agent: KNOWN_COMMIT_AGENTS[0], coAuthors: [] },
      agentImage: image,
    });

    expect(calls.some((call) => call.name === "clip")).toBe(true);
    expect(calls.some((call) => call.name === "fillRect")).toBe(false);
    expect(calls.find((call) => call.name === "drawImage")?.args[0]).toBe(image);
  });

  it("falls back to the classic dot while an agent image is unavailable", () => {
    const { ctx, calls } = fakeContext();
    drawCommitNode({
      ...baseOptions,
      ctx,
      identity: { kind: "agent", agent: KNOWN_COMMIT_AGENTS[0], coAuthors: [] },
      agentImage: null,
    });

    expect(calls.filter((call) => call.name === "arc")[0]?.args[2]).toBe(5);
    expect(calls.some((call) => call.name === "drawImage")).toBe(false);
  });

  it("draws a single co-author as a mini identity badge", () => {
    const { ctx, calls } = fakeContext();
    const badge: CommitNodeBadge = {
      count: 1,
      initials: "JD",
      color: "#e0843b",
      image: null,
    };
    drawCommitNode({
      ...baseOptions,
      ctx,
      identity: { ...human, coAuthors: [coAuthor()] },
      agentImage: null,
      badge,
    });

    const texts = calls.filter((call) => call.name === "fillText").map((call) => call.args[0]);
    expect(texts).toEqual(["AS", "JD"]);
  });

  it("collapses several co-authors into a +N badge", () => {
    const { ctx, calls } = fakeContext();
    const badge: CommitNodeBadge = {
      count: 3,
      initials: "JD",
      color: "#e0843b",
      image: null,
    };
    drawCommitNode({
      ...baseOptions,
      ctx,
      identity: human,
      agentImage: null,
      badge,
    });

    const texts = calls.filter((call) => call.name === "fillText").map((call) => call.args[0]);
    expect(texts).toEqual(["AS", "+3"]);
  });

  it("never badges the classic dot", () => {
    const { ctx, calls } = fakeContext();
    drawCommitNode({
      ...baseOptions,
      ctx,
      identity: null,
      agentImage: null,
      badge: { count: 2, initials: "JD", color: "#e0843b", image: null },
    });
    expect(calls.some((call) => call.name === "fillText")).toBe(false);
  });
});
