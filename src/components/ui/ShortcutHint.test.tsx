import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShortcutHint } from "./ShortcutHint";

describe("ShortcutHint", () => {
  it("renders nothing when there are no keys", () => {
    const { container } = render(<ShortcutHint keys={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("wraps each key in its own badge, hidden from the accessible name", () => {
    render(
      <button type="button">
        Push
        <ShortcutHint keys={["⌘", "⇧", "P"]} />
      </button>,
    );
    const caps = screen.getAllByText(/^[⌘⇧P]$/);
    expect(caps).toHaveLength(3);
    for (const cap of caps) {
      expect(cap.tagName).toBe("KBD");
    }
    expect(screen.getByRole("button", { name: "Push" })).toBeInTheDocument();
  });

  it("uses a light key-cap wash on accent buttons", () => {
    render(<ShortcutHint keys={["⌘", "↵"]} tone="onAccent" />);
    expect(screen.getByText("⌘").className).toContain("bg-white/15");
  });
});
