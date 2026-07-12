import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileChange } from "@/lib/api";
import { emptyChanges } from "@/store/repoTypes";
import { ReviewFileSection } from "./ReviewFileSection";

// GL-197 a11y: the header is a role="button" div (so the stage/unstage control
// can be a real nested <button> without invalid button-in-button), and both
// must be independently operable from the keyboard.

const file: FileChange = { path: "src/app.ts", status: "M", add: 1, del: 0, binary: false };

const props = {
  file,
  source: "unstaged" as const,
  expanded: false,
  loading: false,
  diff: null,
  changes: emptyChanges,
};

afterEach(cleanup);

describe("ReviewFileSection header (a11y)", () => {
  it("exposes the header as a labelled button and the stage control as its own button", () => {
    render(<ReviewFileSection {...props} onHeader={() => {}} onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: "Expand src/app.ts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stage src/app.ts" })).toBeInTheDocument();
  });

  it("activates the header from the keyboard with Enter and Space", () => {
    const onHeader = vi.fn();
    render(<ReviewFileSection {...props} onHeader={onHeader} onToggle={() => {}} />);
    const header = screen.getByRole("button", { name: "Expand src/app.ts" });
    expect(fireEvent.keyDown(header, { key: "Enter" })).toBe(false);
    expect(fireEvent.keyDown(header, { key: " " })).toBe(false);
    expect(onHeader).toHaveBeenCalledTimes(2);
  });

  it("toggling stage from the nested button does not also fire the header", () => {
    const onHeader = vi.fn();
    const onToggle = vi.fn();
    render(<ReviewFileSection {...props} onHeader={onHeader} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: "Stage src/app.ts" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onHeader).not.toHaveBeenCalled();
  });
});
