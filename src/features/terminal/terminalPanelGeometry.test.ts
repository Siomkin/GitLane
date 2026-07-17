import { describe, expect, it } from "vitest";
import { resizeTerminalInsets, TERMINAL_EDGE_MARGIN } from "./terminalPanelGeometry";

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
