import { describe, expect, it } from "vitest";
import { resizeTerminalInsets } from "./terminalPanelGeometry";

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
    expect(
      resizeTerminalInsets({
        side: "left",
        start: { left: 8, right: 8 },
        deltaX: -100,
        containerWidth: 1000,
      }),
    ).toEqual({ left: 8, right: 8 });
    expect(
      resizeTerminalInsets({
        side: "right",
        start: { left: 8, right: 8 },
        deltaX: -900,
        containerWidth: 1000,
      }),
    ).toEqual({ left: 8, right: 472 });
  });
});
