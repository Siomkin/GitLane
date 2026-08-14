import { render } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitNode, RepoGraph } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { GraphLayer } from "./GraphLayer";
import { graphLaneX } from "./palette";

const { drawCommitNodeMock, invokeMock, paintEvents, paintState } = vi.hoisted(() => ({
  drawCommitNodeMock: vi.fn(),
  invokeMock: vi.fn(),
  paintEvents: [] as string[],
  paintState: { dash: [] as number[], alphas: [] as number[] },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("./commitNodePainter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./commitNodePainter")>();
  return {
    ...actual,
    drawCommitNode: (...args: Parameters<typeof actual.drawCommitNode>) => {
      paintEvents.push("node");
      drawCommitNodeMock(...args);
    },
  };
});

const getContextDescriptor = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext",
);

// `width`/`height` are instrumented rather than merely read: the point of the
// resize guard is that a scroll-only repaint performs no assignment at all, and
// happy-dom has no real backing store, so the write itself is the only observable.
// The accessors still behave like the real ones (defaults 300x150) because the
// paint compares `canvas.width` against the wanted size to decide whether to resize.
const sizeDescriptors = {
  width: Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "width"),
  height: Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "height"),
};
const canvasSizes = new WeakMap<HTMLCanvasElement, { width: number; height: number }>();
const DEFAULT_CANVAS_SIZE = { width: 300, height: 150 };
let dimensionWrites = 0;

function instrumentCanvasSize(prop: "width" | "height") {
  Object.defineProperty(HTMLCanvasElement.prototype, prop, {
    configurable: true,
    get(this: HTMLCanvasElement) {
      return (canvasSizes.get(this) ?? DEFAULT_CANVAS_SIZE)[prop];
    },
    set(this: HTMLCanvasElement, value: number) {
      dimensionWrites += 1;
      const current = canvasSizes.get(this) ?? { ...DEFAULT_CANVAS_SIZE };
      current[prop] = value;
      canvasSizes.set(this, current);
    },
  });
}

function restoreCanvasSize(prop: "width" | "height") {
  const descriptor = sizeDescriptors[prop];
  if (descriptor) {
    Object.defineProperty(HTMLCanvasElement.prototype, prop, descriptor);
  } else {
    Reflect.deleteProperty(HTMLCanvasElement.prototype, prop);
  }
}

const context = {
  globalAlpha: 1,
  strokeStyle: "",
  lineWidth: 1,
  lineCap: "butt",
  lineJoin: "miter",
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  setLineDash: vi.fn((dash: number[]) => {
    paintState.dash = [...dash];
  }),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  arcTo: vi.fn(),
  quadraticCurveTo: vi.fn(),
  arc: vi.fn(),
  stroke: vi.fn(() => {
    // Alpha is sampled at stroke time, not asserted at the end: the paint ends
    // on the node loop's per-node value, so only the skeleton's own strokes
    // show whether this pass started from a clean alpha.
    paintState.alphas.push(context.globalAlpha);
    paintEvents.push(`stroke:${String(context.strokeStyle)}:${paintState.dash.join(",")}`);
  }),
} as unknown as CanvasRenderingContext2D;

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => context),
  });
  instrumentCanvasSize("width");
  instrumentCanvasSize("height");
});

afterAll(() => {
  if (getContextDescriptor) {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", getContextDescriptor);
  } else {
    Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
  }
  restoreCanvasSize("width");
  restoreCanvasSize("height");
});

const commit = (id: string, row: number, lane: number): CommitNode => ({
  id,
  shortId: id,
  summary: id,
  body: "",
  authorName: "",
  authorEmail: "",
  timestamp: 0,
  parents: [],
  lane,
  row,
  refs: [],
});

beforeEach(() => {
  paintEvents.length = 0;
  paintState.dash = [];
  paintState.alphas.length = 0;
  dimensionWrites = 0;
  context.globalAlpha = 1;
  context.strokeStyle = "";
  drawCommitNodeMock.mockClear();
  for (const method of [
    context.setTransform,
    context.clearRect,
    context.setLineDash,
    context.beginPath,
    context.moveTo,
    context.lineTo,
    context.arcTo,
    context.quadraticCurveTo,
    context.arc,
    context.stroke,
  ]) {
    vi.mocked(method).mockClear();
  }
  invokeMock.mockReset();
  const commits = [
    commit("above", 0, 0),
    commit("visible", 100, 1),
    commit("below", 200, 2),
  ];
  const graph: RepoGraph = {
    commits,
    edges: [
      { fromRow: 0, fromLane: 0, toRow: 200, toLane: 2, parentIndex: 0, color: 0 },
      { fromRow: 0, fromLane: 3, toRow: 1, toLane: 3, parentIndex: 0, color: 3 },
    ],
    laneCount: 4,
    head: "visible",
    truncated: false,
  };
  useRepo.setState({ graph, selectedCommits: ["visible"] });
  useUi.setState({ showCommitNodeIcons: false });
});

describe("GraphLayer paint candidates", () => {
  it("paints WIP, crossing edges, stash connectors, then only visible commit nodes", () => {
    render(
      <section>
        <div className="gp-root">
          <GraphLayer
            viewportTop={3_400}
            viewportHeight={340}
            hasWip
            rowHeight={34}
            graphWidth={210}
            branchOffset={0}
            visualRowByGraphRow={[]}
            stashConnectors={[
              {
                key: "crossing",
                stashRow: 50,
                anchorRow: 150,
                stashLane: 4,
                anchorLane: 1,
                color: 0,
              },
              {
                key: "above",
                stashRow: 0,
                anchorRow: 1,
                stashLane: 4,
                anchorLane: 1,
                color: 0,
              },
            ]}
            matchedIds={new Set(["above"])}
          />
        </div>
      </section>,
    );

    expect(paintEvents).toEqual([
      "stroke:#2f9e7e:2,3",
      "stroke:#5b8def:",
      "stroke:#f59e0b:3,4",
      "node",
    ]);
    expect(vi.mocked(context.setLineDash).mock.calls).toEqual([
      [[2, 3]],
      [[]],
      [[]],
      [[]],
      [[3, 4]],
      [[]],
    ]);
    expect(paintState.dash).toEqual([]);
    expect(drawCommitNodeMock).toHaveBeenCalledTimes(1);
    expect(drawCommitNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        x: graphLaneX(1),
        y: 51,
        selected: true,
        head: true,
        nodeAlpha: 1,
      }),
    );
    // The crossing edge keeps its full geometry for the curve radius while its
    // endpoints are clamped to the bounded canvas.
    expect(context.arcTo).toHaveBeenCalledWith(
      graphLaneX(0),
      374,
      graphLaneX(2),
      374,
      18,
    );
  });

  it("paints visible WIP connector and node with the captured lane geometry", () => {
    const head = commit("head", 2, 1);
    useRepo.setState({
      graph: {
        commits: [head],
        edges: [],
        laneCount: 4,
        wipLane: 3,
        head: head.id,
        truncated: false,
      },
      selectedCommits: [],
    });

    render(
      <section>
        <div className="gp-root">
          <GraphLayer
            viewportTop={0}
            viewportHeight={170}
            hasWip
            rowHeight={34}
            graphWidth={210}
            branchOffset={0}
            visualRowByGraphRow={[]}
            stashConnectors={[]}
          />
        </div>
      </section>,
    );

    const wipX = graphLaneX(3);
    const headX = graphLaneX(1);
    expect(vi.mocked(context.setLineDash).mock.calls.slice(0, 2)).toEqual([
      [[2, 3]],
      [[]],
    ]);
    expect(context.moveTo).toHaveBeenCalledWith(wipX, 24);
    expect(context.lineTo).toHaveBeenCalledWith(wipX, 107);
    expect(context.quadraticCurveTo).toHaveBeenCalledWith(wipX, 119, headX, 119);
    expect(context.arc).toHaveBeenCalledWith(wipX, 17, 5.5, 0, Math.PI * 2);
    expect(paintEvents.slice(0, 2)).toEqual([
      "stroke:#e0843b:2,3",
      "stroke:#e0843b:2,3",
    ]);
    expect(paintState.dash).toEqual([]);
  });

  it("paints an injected stash edge amber and dashed but omits its canvas node", () => {
    const stash = {
      ...commit("stash", 0, 2),
      stash: { index: 0, message: "saved" },
    };
    const base = commit("base", 1, 0);
    useRepo.setState({
      graph: {
        commits: [stash, base],
        edges: [
          { fromRow: 0, fromLane: 2, toRow: 1, toLane: 0, parentIndex: 0, color: 2 },
        ],
        laneCount: 3,
        head: base.id,
        truncated: false,
      },
      selectedCommits: [],
    });

    render(
      <section>
        <div className="gp-root">
          <GraphLayer
            viewportTop={0}
            viewportHeight={102}
            hasWip={false}
            rowHeight={34}
            graphWidth={210}
            branchOffset={0}
            visualRowByGraphRow={[]}
            stashConnectors={[]}
            matchedIds={new Set([stash.id])}
          />
        </div>
      </section>,
    );

    expect(paintEvents).toEqual(["stroke:#f59e0b:3,4", "node"]);
    expect(drawCommitNodeMock).toHaveBeenCalledTimes(1);
    expect(drawCommitNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        x: graphLaneX(base.lane),
        nodeAlpha: 0.25,
      }),
    );
    expect(vi.mocked(context.setLineDash).mock.calls.slice(0, 2)).toEqual([
      [[3, 4]],
      [[]],
    ]);
  });

  it("forwards a visible merge as a larger hollow node", () => {
    const merge = { ...commit("merge", 0, 1), parents: ["left", "right"] };
    useRepo.setState({
      graph: {
        commits: [merge],
        edges: [],
        laneCount: 2,
        head: merge.id,
        truncated: false,
      },
      selectedCommits: [],
    });

    render(
      <section>
        <div className="gp-root">
          <GraphLayer
            viewportTop={0}
            viewportHeight={68}
            hasWip={false}
            rowHeight={34}
            graphWidth={210}
            branchOffset={0}
            visualRowByGraphRow={[]}
            stashConnectors={[]}
          />
        </div>
      </section>,
    );

    expect(drawCommitNodeMock).toHaveBeenCalledTimes(1);
    expect(drawCommitNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        merge: true,
        outerRadius: 7.5,
        nodeAlpha: 1,
      }),
    );
  });

  it("resizes the backing store only when the device-pixel size changes", () => {
    const layer = (viewportTop: number, viewportHeight = 340) => (
      <section>
        <div className="gp-root">
          <GraphLayer
            viewportTop={viewportTop}
            viewportHeight={viewportHeight}
            hasWip={false}
            rowHeight={34}
            graphWidth={210}
            branchOffset={0}
            visualRowByGraphRow={[]}
            stashConnectors={[]}
          />
        </div>
      </section>
    );

    // The first paint has to size the fresh bitmap.
    const { rerender } = render(layer(0));
    expect(dimensionWrites).toBeGreaterThan(0);

    dimensionWrites = 0;
    rerender(layer(340));
    rerender(layer(680));
    // Scrolling repaints but must not touch the backing store. Without the guard
    // this silently regresses to a multi-MB reallocation on every scroll tick.
    expect(dimensionWrites).toBe(0);

    // A genuine size change still has to resize.
    rerender(layer(680, 500));
    expect(dimensionWrites).toBeGreaterThan(0);
  });

  it("repaints at full strength after a filtered paint left the alpha dimmed", () => {
    const layer = (matchedIds: Set<string> | null) => (
      <section>
        <div className="gp-root">
          <GraphLayer
            viewportTop={0}
            viewportHeight={340}
            hasWip={false}
            rowHeight={34}
            graphWidth={210}
            branchOffset={0}
            visualRowByGraphRow={[]}
            stashConnectors={[]}
            matchedIds={matchedIds}
          />
        </div>
      </section>
    );

    // A filter matching nothing on screen: the skeleton dims, and the node loop's
    // last write leaves the context's alpha at DIM_ALPHA when the pass ends.
    const { rerender } = render(layer(new Set(["visible"])));
    expect(paintState.alphas).not.toHaveLength(0);
    expect(paintState.alphas.every((alpha) => alpha === 0.25)).toBe(true);
    expect(context.globalAlpha).toBe(0.25);

    paintState.alphas.length = 0;
    rerender(layer(null));

    // Clearing the filter has to paint the skeleton solid again. The canvas is no
    // longer resized on every paint, so nothing implicitly restores alpha to 1 —
    // without an explicit reset the whole graph stays dimmed after any search.
    expect(paintState.alphas).not.toHaveLength(0);
    expect(paintState.alphas.every((alpha) => alpha === 1)).toBe(true);
  });
});
