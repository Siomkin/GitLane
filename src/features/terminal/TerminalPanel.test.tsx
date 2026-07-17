import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUi } from "@/store/ui";
import { TerminalLayer } from "./TerminalPanel";

vi.mock("@/features/terminal/panes", () => ({
  useTerminalPanes: () => ({
    hostRef: { current: null },
    alive: true,
    agents: [],
    terminalPath: "/Volumes/External/Develop/GitLane",
    runAgent: vi.fn(),
    clearTerminal: vi.fn(),
  }),
}));

vi.mock("./TerminalTabs", () => ({
  TerminalTabs: () => <div>Terminal tabs</div>,
}));

beforeEach(() => {
  useUi.setState({
    terminalView: "open",
    terminalViewByRepo: {},
    terminalHeight: 480,
    terminalBottomInset: 10,
    terminalHorizontalLayout: null,
    terminalExpanded: false,
  });
});

/** Pin the panel (x 100..1100 in a 1200-wide container; y 280..760 in an
 * 800-tall one, so a 40px bottom gap leaves ample room above for the height
 * cap) so both inset and vertical math are exact. */
function mockPanelRects(panel: HTMLDivElement) {
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
    width: 1000,
    height: 480,
    x: 100,
    y: 280,
    top: 280,
    right: 1100,
    bottom: 760,
    left: 100,
    toJSON: () => ({}),
  });
  vi.spyOn(panel.parentElement as HTMLElement, "getBoundingClientRect").mockReturnValue({
    width: 1200,
    height: 800,
    x: 0,
    y: 0,
    top: 0,
    right: 1200,
    bottom: 800,
    left: 0,
    toJSON: () => ({}),
  });
}

describe("TerminalLayer", () => {
  it("uses a left-aligned 50% width until the user resizes it", () => {
    render(<TerminalLayer />);
    const panel = screen.getByRole("separator", {
      name: "Resize terminal width from right",
    }).parentElement as HTMLDivElement;

    expect(panel).toHaveStyle({
      bottom: "10px",
      left: "10px",
      right: "calc(50% - 10px)",
    });
  });

  it("moves one popup edge without moving the opposite edge", () => {
    render(<TerminalLayer />);
    const rightHandle = screen.getByRole("separator", {
      name: "Resize terminal width from right",
    });
    const panel = rightHandle.parentElement as HTMLDivElement;
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      width: 1000,
      height: 480,
      x: 100,
      y: 0,
      top: 0,
      right: 1100,
      bottom: 480,
      left: 100,
      toJSON: () => ({}),
    });
    vi.spyOn(panel.parentElement as HTMLElement, "getBoundingClientRect").mockReturnValue({
      width: 1200,
      height: 800,
      x: 0,
      y: 0,
      top: 0,
      right: 1200,
      bottom: 800,
      left: 0,
      toJSON: () => ({}),
    });

    fireEvent.mouseDown(rightHandle, { clientX: 1100 });
    fireEvent.mouseMove(window, { clientX: 900 });
    fireEvent.mouseUp(window);

    expect(useUi.getState()).toMatchObject({
      terminalHorizontalLayout: { leftInset: 100, rightInset: 300 },
    });
    expect(panel).toHaveStyle({ left: "100px", right: "300px" });
  });

  it("resizes both axes at once from a top-corner drag", () => {
    render(<TerminalLayer />);
    const corner = screen.getByRole("button", {
      name: "Resize terminal height and width from top right",
    });
    mockPanelRects(corner.parentElement as HTMLDivElement);

    // Up-left: grows the height (+120) and pulls the right edge in (-200).
    fireEvent.mouseDown(corner, { clientX: 1100, clientY: 320 });
    fireEvent.mouseMove(window, { clientX: 900, clientY: 200 });
    fireEvent.mouseUp(window);

    expect(useUi.getState().terminalHeight).toBe(600);
    expect(useUi.getState()).toMatchObject({
      terminalHorizontalLayout: { leftInset: 100, rightInset: 300 },
    });
  });

  it("resizes one axis per arrow key on a corner handle", () => {
    render(<TerminalLayer />);
    const corner = screen.getByRole("button", {
      name: "Resize terminal height and width from top right",
    });
    mockPanelRects(corner.parentElement as HTMLDivElement);

    fireEvent.keyDown(corner, { key: "ArrowUp" });
    expect(useUi.getState().terminalHeight).toBe(496);

    fireEvent.keyDown(corner, { key: "ArrowDown", shiftKey: true });
    expect(useUi.getState().terminalHeight).toBe(448);

    // Right corner: ArrowLeft pulls the right edge in (inset grows, panel narrows).
    fireEvent.keyDown(corner, { key: "ArrowLeft" });
    expect(useUi.getState()).toMatchObject({
      terminalHorizontalLayout: { leftInset: 100, rightInset: 132 },
    });
  });

  it("lifts the panel floor from a bottom-edge drag, keeping the top fixed", () => {
    render(<TerminalLayer />);
    const bottomHandle = screen.getByRole("separator", {
      name: "Resize terminal from bottom",
    });
    const panel = bottomHandle.parentElement as HTMLDivElement;
    // Panel: 480 tall, bottom gap 60 (container 800 → panel bottom at 740).
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      width: 1000, height: 480, x: 100, y: 260, top: 260, right: 1100,
      bottom: 740, left: 100, toJSON: () => ({}),
    });
    vi.spyOn(panel.parentElement as HTMLElement, "getBoundingClientRect").mockReturnValue({
      width: 1200, height: 800, x: 0, y: 0, top: 0, right: 1200,
      bottom: 800, left: 0, toJSON: () => ({}),
    });

    // Drag the bottom edge up 100px: floor rises (60 → 160), height shrinks
    // (480 → 380), top edge (bottom + height = 540) is unchanged.
    fireEvent.mouseDown(bottomHandle, { clientY: 740 });
    fireEvent.mouseMove(window, { clientY: 640 });
    fireEvent.mouseUp(window);

    expect(useUi.getState().terminalBottomInset).toBe(160);
    expect(useUi.getState().terminalHeight).toBe(380);
    expect(panel).toHaveStyle({ bottom: "160px" });
  });

  it("caps a top-edge drag so a lifted panel's top stays inside the container", () => {
    // Floor already lifted 500px off the bottom, short panel above it.
    useUi.setState({ terminalBottomInset: 500, terminalHeight: 200 });
    render(<TerminalLayer />);
    const topHandle = screen.getByRole("separator", { name: "Resize terminal height" });
    const panel = topHandle.parentElement as HTMLDivElement;
    // Container 800 tall; panel bottom at 300 (→ 500 gap), 200 tall (top at 100).
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      width: 1000, height: 200, x: 100, y: 100, top: 100, right: 1100,
      bottom: 300, left: 100, toJSON: () => ({}),
    });
    vi.spyOn(panel.parentElement as HTMLElement, "getBoundingClientRect").mockReturnValue({
      width: 1200, height: 800, x: 0, y: 0, top: 0, right: 1200,
      bottom: 800, left: 0, toJSON: () => ({}),
    });

    // Drag the top edge up 400px: unbounded that wants height 600 (top at -100,
    // under the ActionBar). Capped to 800 - 10 margin - 500 floor = 290.
    fireEvent.mouseDown(topHandle, { clientY: 100 });
    fireEvent.mouseMove(window, { clientY: -300 });
    fireEvent.mouseUp(window);

    expect(useUi.getState().terminalHeight).toBe(290);
    // Top edge = 800 - 500 - 290 = 10, exactly the edge margin — still visible.
    expect(useUi.getState().terminalBottomInset + useUi.getState().terminalHeight).toBe(790);
  });

  it("squares the gap backdrop only on edge-aligned bottom corners", () => {
    render(<TerminalLayer />);
    const panel = screen.getByRole("separator", {
      name: "Resize terminal width from right",
    }).parentElement as HTMLDivElement;
    const backdrop = panel.previousElementSibling as HTMLDivElement;

    // Default layout: left edge at the margin (squared), right edge interior.
    expect(backdrop).toHaveClass("rounded-bl-none", "rounded-br-xl");
    expect(backdrop).toHaveStyle({ bottom: "10px", left: "10px" });

    // Lifted off the floor: no bottom corner touches a block corner, so both
    // stay rounded even though the left side is still edge-aligned.
    act(() => useUi.setState({ terminalBottomInset: 120 }));
    expect(backdrop).toHaveClass("rounded-bl-xl", "rounded-br-xl");
    act(() => useUi.setState({ terminalBottomInset: 10 }));

    // Interior on both sides: fully rounded, hidden behind the drawer.
    act(() => useUi.setState({ terminalHorizontalLayout: { leftInset: 120, rightInset: 260 } }));
    expect(backdrop).toHaveClass("rounded-bl-xl", "rounded-br-xl");

    // Maximized: both edges at the margin, both corners squared.
    fireEvent.click(screen.getByRole("button", { name: "Maximize terminal" }));
    expect(backdrop).toHaveClass("rounded-bl-none", "rounded-br-none");
  });

  it("fades the backdrop with the drawer instead of hiding it instantly", () => {
    render(<TerminalLayer />);
    const panel = screen.getByRole("separator", {
      name: "Resize terminal width from right",
    }).parentElement as HTMLDivElement;
    const backdrop = panel.previousElementSibling as HTMLDivElement;
    expect(backdrop).not.toHaveClass("hidden");
    expect(backdrop).not.toHaveClass("opacity-0");

    // Collapsed: stays mounted and runs the drawer's fade so the pair animate
    // as one (instant display:none would flash the corner hairline back).
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(backdrop).toHaveClass("opacity-0");
    expect(backdrop).not.toHaveClass("hidden");

    // Fully hidden view: display none, same as the drawer.
    act(() => useUi.setState({ terminalView: "hidden" }));
    expect(backdrop).toHaveClass("hidden");
  });

  it("collapses to a running-status launcher and restores on click", () => {
    render(<TerminalLayer />);

    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));

    expect(useUi.getState().terminalView).toBe("collapsed");
    expect(screen.getByText("Terminal running")).toBeVisible();
    expect(screen.queryByText("/Volumes/External/Develop/GitLane")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Terminal running" }));
    expect(useUi.getState().terminalView).toBe("open");
  });

  it("uses the full available width while maximized and restores the saved width", () => {
    useUi.setState({
      terminalHorizontalLayout: { leftInset: 120, rightInset: 260 },
    });
    render(<TerminalLayer />);
    const panel = screen.getByRole("separator", {
      name: "Resize terminal width from right",
    }).parentElement as HTMLDivElement;

    expect(panel).toHaveStyle({ left: "120px", right: "260px" });
    fireEvent.click(screen.getByRole("button", { name: "Maximize terminal" }));
    expect(panel).toHaveStyle({ bottom: "10px", left: "10px", right: "10px" });
    expect(screen.queryByRole("separator", { name: /Resize terminal width/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Resize terminal height and width/ }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Restore terminal size" }));
    expect(panel).toHaveStyle({ left: "120px", right: "260px" });
  });
});
