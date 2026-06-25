import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Resizer } from "./Resizer";

describe("Resizer", () => {
  it("reports drag movement as incremental deltas", () => {
    const onResize = vi.fn();
    render(<Resizer onResize={onResize} />);

    fireEvent.mouseDown(screen.getByRole("separator", { name: "Resize panels" }), {
      clientX: 200,
    });
    fireEvent.mouseMove(window, { clientX: 212 });
    fireEvent.mouseMove(window, { clientX: 205 });

    expect(onResize.mock.calls).toEqual([[12], [-7]]);

    fireEvent.mouseUp(window);
    fireEvent.mouseMove(window, { clientX: 230 });
    expect(onResize).toHaveBeenCalledTimes(2);
  });

  it("supports keyboard resizing while focused", () => {
    const onResize = vi.fn();
    render(<Resizer onResize={onResize} />);

    const separator = screen.getByRole("separator", { name: "Resize panels" });
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator).toHaveAttribute("title", "Drag to resize");

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    fireEvent.keyDown(separator, { key: "Escape" });

    expect(onResize.mock.calls).toEqual([[-16], [16]]);
  });
});
