import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchableSelect, type SearchableSelectOption } from "./SearchableSelect";

const options: SearchableSelectOption[] = [
  { value: "gpt-5", label: "GPT-5" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
];

const setup = (over: Partial<Parameters<typeof SearchableSelect>[0]> = {}) => {
  const onChange = vi.fn();
  const props = { value: "", options, onChange, ariaLabel: "Model", ...over };
  const { rerender } = render(<SearchableSelect {...props} />);
  return {
    input: screen.getByRole("combobox", { name: over.ariaLabel ?? "Model" }),
    onChange,
    rerender: (next: Partial<Parameters<typeof SearchableSelect>[0]>) =>
      rerender(<SearchableSelect {...props} {...next} />),
  };
};

describe("SearchableSelect highlight", () => {
  it("opens with no highlight — Enter picks nothing until the user moves", () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-activedescendant");

    // The default must be "no highlight" (`-1`): Enter on an untouched list
    // is a no-op, never a pick of row 0 the user never arrowed to.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("steps with arrows and wraps at both ends", () => {
    const { input, onChange } = setup();
    fireEvent.focus(input);

    // ArrowUp from no active row selects the LAST item, not the penultimate
    // (a plain modulo step from -1 would land on n-2).
    fireEvent.keyDown(input, { key: "ArrowUp" });
    let items = screen.getAllByRole("option");
    expect(input).toHaveAttribute("aria-activedescendant", items[2].id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("opus");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    // Reopen and wrap forward off the end back to the first item.
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    items = screen.getAllByRole("option");
    expect(input).toHaveAttribute("aria-activedescendant", items[0].id);
  });

  it("keeps the highlight on a rendered option when the options prop shrinks", () => {
    const { input, rerender, onChange } = setup();
    fireEvent.focus(input);
    // Highlight the last (index 2) option.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[2].id);

    // The options prop shrinks (before, a stale out-of-range index survived
    // this — the clamp only ran at render, never normalizing the raw state):
    // activedescendant must clamp to a rendered id, never dangle at index 2.
    rerender({ options: [options[0]] });
    const survivors = screen.getAllByRole("option");
    expect(survivors).toHaveLength(1);
    expect(input.getAttribute("aria-activedescendant")).toBe(survivors[0].id);

    // Enter picks the surviving (clamped) option, not nothing.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("gpt-5");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("normalizes a stale highlight through a shrink then regrow (3→1→3)", () => {
    const { input, rerender } = setup();
    fireEvent.focus(input);
    // Highlight index 2, shrink to one (clamps raw state to 0), regrow to three.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    rerender({ options: [options[0]] });
    rerender({ options });
    // The old index-2 highlight must not resurface; it settled at the clamped
    // index 0.
    const items = screen.getAllByRole("option");
    expect(input).toHaveAttribute("aria-activedescendant", items[0].id);
  });

  it("starts each fresh query unhighlighted", () => {
    const { input } = setup();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant");

    fireEvent.change(input, { target: { value: "gpt" } });
    expect(input).not.toHaveAttribute("aria-activedescendant");
    // And typing does not pick anything by itself.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });
});
