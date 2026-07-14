import { fireEvent, render, screen } from "@testing-library/react";
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
    terminalHorizontalLayout: null,
    terminalExpanded: false,
  });
});

describe("TerminalLayer", () => {
  it("uses a left-aligned 50% width until the user resizes it", () => {
    render(<TerminalLayer />);
    const panel = screen.getByRole("separator", {
      name: "Resize terminal width from right",
    }).parentElement as HTMLDivElement;

    expect(panel).toHaveStyle({
      bottom: "8px",
      left: "8px",
      right: "calc(50% - 8px)",
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
    expect(panel).toHaveStyle({ bottom: "8px", left: "8px", right: "8px" });
    expect(screen.queryByRole("separator", { name: /Resize terminal width/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Restore terminal size" }));
    expect(panel).toHaveStyle({ left: "120px", right: "260px" });
  });
});
