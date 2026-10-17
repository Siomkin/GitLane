// A crashing overlay is contained to that overlay: a closable card replaces it,
// and Close/Escape clear the overlay's own open flag before the boundary resets
// so the next open mounts it fresh.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OverlayBoundary } from "./OverlayBoundary";

let open = true;
let throws = true;
const Flaky = () => {
  if (!open) return null;
  if (throws) throw new Error("boom");
  return <div>overlay body</div>;
};

beforeEach(() => {
  open = true;
  throws = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("OverlayBoundary", () => {
  it("shows a closable card when the overlay throws", () => {
    render(<OverlayBoundary entry={{ id: "x", Overlay: Flaky, close: () => {} }} />);

    expect(screen.getByRole("alert")).toHaveTextContent("boom");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("Close runs the overlay's close, then renders the closed overlay", async () => {
    const close = vi.fn(() => (open = false));
    render(<OverlayBoundary entry={{ id: "x", Overlay: Flaky, close }} />);

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Escape closes the card like Close", () => {
    const close = vi.fn(() => (open = false));
    render(<OverlayBoundary entry={{ id: "x", Overlay: Flaky, close }} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reopening after Close mounts the overlay fresh", async () => {
    const close = vi.fn(() => (open = false));
    const { rerender } = render(<OverlayBoundary entry={{ id: "x", Overlay: Flaky, close }} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    open = true;
    throws = false;
    rerender(<OverlayBoundary entry={{ id: "x", Overlay: Flaky, close }} />);

    expect(screen.getByText("overlay body")).toBeInTheDocument();
  });

  it("drops a non-closable overlay's crash silently", () => {
    const { container } = render(<OverlayBoundary entry={{ id: "x", Overlay: Flaky, close: null }} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("retries a non-closable overlay when its reset key changes", () => {
    let key = 1;
    const entry = { id: "x", Overlay: Flaky, close: null, useResetKey: () => key };
    const { container, rerender } = render(<OverlayBoundary entry={entry} />);
    expect(container).toBeEmptyDOMElement();

    throws = false;
    key = 2;
    rerender(<OverlayBoundary entry={entry} />);

    expect(screen.getByText("overlay body")).toBeInTheDocument();
  });
});
