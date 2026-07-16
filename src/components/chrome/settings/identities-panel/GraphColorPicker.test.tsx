import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useUi } from "@/store/ui";
import { IDENTITY_COLORS } from "@/lib/identityColor";
import { GraphColorPicker } from "./GraphColorPicker";

afterEach(() => {
  useUi.setState({ identityColors: {} });
});

describe("GraphColorPicker", () => {
  it("opens on click, then pins a preset colour for the email", async () => {
    const user = userEvent.setup();
    render(<GraphColorPicker email="Jane@Example.com" />);

    expect(screen.queryByRole("button", { name: /^Use #/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /colour/i }));

    // The popover must sit above the Settings modal (z-[80]); it portals into
    // `.gp-root` beside the modal, so a lower z-index hides it behind it.
    expect(screen.getByText("Graph colour").parentElement?.className).toContain("z-[90]");

    const swatch = IDENTITY_COLORS[3];
    await user.click(screen.getByRole("button", { name: `Use ${swatch}` }));
    // Stored under the normalized (lower-cased) email.
    expect(useUi.getState().identityColors).toEqual({ "jane@example.com": swatch });
  });

  it("does not bubble a swatch mousedown to the document (keeps Settings open)", async () => {
    // The Settings modal dismisses on any mousedown outside its dialog; the
    // portaled popover is outside it, so its mousedowns must not reach the
    // document-level listener or the whole modal would close on a swatch click.
    const user = userEvent.setup();
    const documentMouseDown = vi.fn();
    document.addEventListener("mousedown", documentMouseDown);
    try {
      render(<GraphColorPicker email="jane@example.com" />);
      await user.click(screen.getByRole("button", { name: /colour/i }));
      documentMouseDown.mockClear();

      const swatch = IDENTITY_COLORS[1];
      fireEvent.mouseDown(screen.getByRole("button", { name: `Use ${swatch}` }));
      expect(documentMouseDown).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: `Use ${swatch}` }));
      expect(useUi.getState().identityColors).toEqual({ "jane@example.com": swatch });
    } finally {
      document.removeEventListener("mousedown", documentMouseDown);
    }
  });

  it("accepts a custom colour and resets to default", async () => {
    const user = userEvent.setup();
    render(<GraphColorPicker email="jane@example.com" />);
    await user.click(screen.getByRole("button", { name: /colour/i }));

    fireEvent.change(screen.getByLabelText("Custom colour"), { target: { value: "#abcdef" } });
    expect(useUi.getState().identityColors).toEqual({ "jane@example.com": "#abcdef" });

    await user.click(screen.getByRole("button", { name: /reset to default/i }));
    expect(useUi.getState().identityColors).toEqual({});
  });
});
