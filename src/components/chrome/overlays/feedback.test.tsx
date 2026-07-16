import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useUi } from "@/store/ui";
import { Tooltip, useTruncatedTooltip } from "./feedback";

// The floating tooltip is store-driven: useTruncatedTooltip shows it on
// mouseenter of a truncated element and hides it on mouseleave. The regression
// this suite locks: clicking a navigator row closes the dropdown and unmounts
// the row before mouseleave fires, which used to strand the tooltip on screen.

function Row({ text }: { text: string }) {
  const tip = useTruncatedTooltip(text);
  return (
    <div {...tip} data-testid="row">
      <span data-truncate>{text}</span>
    </div>
  );
}

/** jsdom has no layout, so fake the "text is truncated" measurement. */
const markTruncated = (el: HTMLElement) => {
  Object.defineProperty(el, "scrollWidth", { value: 200, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: 100, configurable: true });
};

beforeEach(() => {
  useUi.setState({ tooltip: null });
});

describe("useTruncatedTooltip", () => {
  it("shows the tooltip on hover only when the text is truncated", () => {
    render(<Row text="gitlane-optional-auto-fetch" />);
    const row = screen.getByTestId("row");
    // Not truncated (scrollWidth = clientWidth = 0 in jsdom) — no tooltip.
    fireEvent.mouseEnter(row);
    expect(useUi.getState().tooltip).toBeNull();
    markTruncated(row.querySelector("[data-truncate]") as HTMLElement);
    fireEvent.mouseEnter(row);
    expect(useUi.getState().tooltip?.text).toBe("gitlane-optional-auto-fetch");
    fireEvent.mouseLeave(row);
    expect(useUi.getState().tooltip).toBeNull();
  });

  it("hides its tooltip when the hovered element unmounts without mouseleave", () => {
    const { unmount } = render(<Row text="gitlane-optional-auto-fetch" />);
    const row = screen.getByTestId("row");
    markTruncated(row.querySelector("[data-truncate]") as HTMLElement);
    fireEvent.mouseEnter(row);
    expect(useUi.getState().tooltip).not.toBeNull();
    unmount();
    expect(useUi.getState().tooltip).toBeNull();
  });

  it("does not clear another element's tooltip on unmount", () => {
    const { unmount } = render(<Row text="never-hovered" />);
    useUi.getState().showTooltip("someone-else", 10, 10);
    unmount();
    expect(useUi.getState().tooltip?.text).toBe("someone-else");
  });

  it("does not clear a tooltip that replaced its own before unmount", () => {
    const { unmount } = render(<Row text="gitlane-optional-auto-fetch" />);
    const row = screen.getByTestId("row");
    markTruncated(row.querySelector("[data-truncate]") as HTMLElement);
    fireEvent.mouseEnter(row);
    // Another element takes over the tooltip without this row's mouseleave.
    useUi.getState().showTooltip("someone-else", 10, 10);
    unmount();
    expect(useUi.getState().tooltip?.text).toBe("someone-else");
  });
});

describe("Tooltip", () => {
  it("renders the store's tooltip text and nothing when cleared", async () => {
    const { container } = render(<Tooltip />);
    expect(container).toBeEmptyDOMElement();
    useUi.getState().showTooltip("full-branch-name", 40, 40);
    // Store updates outside React need a re-render via the subscription.
    expect(await screen.findByText("full-branch-name")).toBeInTheDocument();
    useUi.getState().hideTooltip();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
