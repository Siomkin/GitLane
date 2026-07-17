import { describe, expect, it } from "vitest";
import {
  resizeTerminalFromBottom,
  resizeTerminalInsets,
  TERMINAL_EDGE_MARGIN,
} from "./terminalPanelGeometry";

describe("resizeTerminalInsets", () => {
  it("moves the left edge and keeps the right edge fixed", () => {
    expect(
      resizeTerminalInsets({
        side: "left",
        start: { left: 20, right: 40 },
        deltaX: 180,
        containerWidth: 1400,
      }),
    ).toEqual({ left: 200, right: 40 });
  });

  it("moves the right edge and keeps the left edge fixed", () => {
    expect(
      resizeTerminalInsets({
        side: "right",
        start: { left: 20, right: 40 },
        deltaX: -160,
        containerWidth: 1400,
      }),
    ).toEqual({ left: 20, right: 200 });
  });

  it("preserves the minimum edge margin and terminal width", () => {
    const m = TERMINAL_EDGE_MARGIN;
    expect(
      resizeTerminalInsets({
        side: "left",
        start: { left: m, right: m },
        deltaX: -100,
        containerWidth: 1000,
      }),
    ).toEqual({ left: m, right: m });
    expect(
      resizeTerminalInsets({
        side: "right",
        start: { left: m, right: m },
        deltaX: -900,
        containerWidth: 1000,
      }),
      // Right edge stops where the panel would dip under MIN_TERMINAL_WIDTH.
    ).toEqual({ left: m, right: 1000 - m - 520 });
  });
});

describe("resizeTerminalFromBottom", () => {
  // A container tall enough that the top-edge cap never bites, so these cases
  // exercise the bottom/height clamps in isolation.
  const TALL = 2000;

  it("lowers the bottom gap and grows the height, keeping the top fixed", () => {
    // Dragging the bottom edge DOWN by 60px: bottom 100 → 40, height 300 → 360.
    // The top anchor (bottom + height = 400) is unchanged.
    expect(
      resizeTerminalFromBottom({ start: { bottom: 100, height: 300 }, deltaY: 60, containerHeight: TALL }),
    ).toEqual({ bottom: 40, height: 360 });
  });

  it("raises the bottom gap and shrinks the height when dragged up", () => {
    expect(
      resizeTerminalFromBottom({ start: { bottom: 100, height: 300 }, deltaY: -80, containerHeight: TALL }),
    ).toEqual({ bottom: 180, height: 220 });
  });

  it("never lets the bottom dip below the edge margin", () => {
    const { bottom, height } = resizeTerminalFromBottom({
      start: { bottom: TERMINAL_EDGE_MARGIN, height: 300 },
      deltaY: 200,
      containerHeight: TALL,
    });
    expect(bottom).toBe(TERMINAL_EDGE_MARGIN);
    expect(height).toBe(300);
  });

  it("clamps the height to its maximum, holding the top fixed", () => {
    // topAnchor 900, max height 860 → bottom floored at 40.
    expect(
      resizeTerminalFromBottom({ start: { bottom: 400, height: 500 }, deltaY: 900, containerHeight: TALL }),
    ).toEqual({ bottom: 40, height: 860 });
  });

  it("clamps the height to its minimum when dragged far up", () => {
    // topAnchor 400, min height 160 → bottom capped at 240.
    expect(
      resizeTerminalFromBottom({ start: { bottom: 100, height: 300 }, deltaY: -500, containerHeight: TALL }),
    ).toEqual({ bottom: 240, height: 160 });
  });

  it("pulls a top edge that overflows the container back into view", () => {
    // Stored geometry from a taller window (topAnchor 1560) no longer fits an
    // 800px container: topAnchor is capped to 800 - margin = 790. With min
    // height 160 that forces bottom down to 630, so the top lands at the margin.
    const next = resizeTerminalFromBottom({
      start: { bottom: 700, height: 860 },
      deltaY: 0,
      containerHeight: 800,
    });
    expect(next).toEqual({ bottom: 630, height: 160 });
    // Top edge = container - bottom - height, back inside the container.
    expect(800 - next.bottom - next.height).toBe(TERMINAL_EDGE_MARGIN);
  });
});
