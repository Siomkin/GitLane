// Lane colors + layout geometry for the commit graph. The Rust layer emits a
// `color` index per commit/edge; we mod it into this palette. Values mirror the
// GitLane design prototype so the painted graph matches the mockup exactly.

export const LANE_COLORS = [
  "#5b8def", // blue
  "#2f9e7e", // green
  "#c875d6", // purple
  "#e0843b", // orange
  "#48b9c7", // cyan
  "#d9756b", // red
  "#c2a13c", // gold
  "#7c8cf8", // indigo
] as const;

export const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];

// The graph canvas is a fixed-width column between the BRANCH/TAG column and the
// message column. Geometry is in canvas-local pixels.
export const GEOMETRY = {
  branchWidth: 176,
  graphWidth: 210, // GW — width of the GRAPH column / canvas
  laneWidth: 22, // LANEW
  padLeft: 18, // PADL
  nodeRadius: 5, // NODER
  laneOffset: 11, // x = padLeft + lane*laneWidth + laneOffset
  rowHeight: 34,
};

/** Pixel x of a lane center inside the full history surface. */
export const laneX = (lane: number) =>
  GEOMETRY.branchWidth +
  GEOMETRY.padLeft +
  lane * GEOMETRY.laneWidth +
  GEOMETRY.laneOffset;

/** Pixel x of a lane center inside the graph-column canvas. */
export const graphLaneX = (lane: number) =>
  GEOMETRY.padLeft + lane * GEOMETRY.laneWidth + GEOMETRY.laneOffset;

/** Pixel y of a row center inside the graph canvas. `rowHeight` varies with the
 * graph-density setting (Compact 34 / Comfortable 46). */
export const rowY = (row: number, rowHeight: number = GEOMETRY.rowHeight) =>
  row * rowHeight + rowHeight / 2;

/** Left offset for the message column after the graph lanes. */
export const gutterWidth = (laneCount: number) =>
  Math.max(
    GEOMETRY.branchWidth + GEOMETRY.graphWidth,
    laneX(Math.max(0, laneCount - 1)) + 42,
  );
