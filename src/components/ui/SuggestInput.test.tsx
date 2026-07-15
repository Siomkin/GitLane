import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SuggestInput } from "./SuggestInput";

const items = [
  { value: "latest", hint: "branch" },
  { value: "feat/search", hint: "branch" },
];

const setup = (over: Partial<Parameters<typeof SuggestInput>[0]> = {}) => {
  const onPick = vi.fn();
  const onChange = vi.fn();
  const props = { value: "", onChange, onPick, items, ariaLabel: "Revision", ...over };
  const { rerender } = render(<SuggestInput {...props} />);
  return {
    input: screen.getByRole("combobox", { name: over.ariaLabel ?? "Revision" }),
    onPick,
    onChange,
    rerender: (next: Partial<Parameters<typeof SuggestInput>[0]>) =>
      rerender(<SuggestInput {...props} {...next} />),
  };
};

describe("SuggestInput", () => {
  it("opens the list on focus and picks with the mouse", () => {
    const { input, onPick } = setup();
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByRole("button", { name: /feat\/search/ }));
    expect(onPick).toHaveBeenCalledWith("feat/search");
    // Picking closes the list.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("navigates with arrows and picks with Enter", () => {
    const { input, onPick } = setup();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("feat/search");
  });

  it("ArrowUp from no active row selects the LAST item, not the penultimate", () => {
    const { input, onPick } = setup();
    fireEvent.focus(input); // open, nothing highlighted (active === -1)
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    // With a plain modulo step from -1 this would land on index n-2 (here
    // "latest"); the fix makes it the last item.
    expect(onPick).toHaveBeenCalledWith("feat/search");
  });

  it("ArrowDown from no active row selects the FIRST item", () => {
    const { input, onPick } = setup();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("latest");
  });

  it("leaves Enter alone while no item is active (form submit stays default)", () => {
    const { input, onPick } = setup();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("wires aria-controls and aria-activedescendant to the active option", () => {
    const { input } = setup();
    fireEvent.focus(input);
    // Open with nothing highlighted: controls the listbox, no active descendant.
    const listbox = screen.getByRole("listbox");
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).not.toHaveAttribute("aria-activedescendant");

    // Arrow to the first option: activedescendant points at its id.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const [first] = screen.getAllByRole("option");
    expect(first.id).toBeTruthy();
    expect(input).toHaveAttribute("aria-activedescendant", first.id);

    // Closing clears both associations.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).not.toHaveAttribute("aria-controls");
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("keeps aria-activedescendant on a rendered option when the list shrinks", () => {
    const three = [
      { value: "a", hint: "branch" },
      { value: "b", hint: "branch" },
      { value: "c", hint: "branch" },
    ];
    const { input, rerender, onPick } = setup({ items: three });
    fireEvent.focus(input);
    // Highlight the last (index 2) option.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[2].id);

    // Shrink to a single item: activedescendant must clamp to a rendered id,
    // never dangle at the old index-2 id (no post-paint frame gap).
    rerender({ items: [three[0]] });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    const activedescendant = input.getAttribute("aria-activedescendant");
    expect(activedescendant).toBe(options[0].id);

    // Enter now picks the surviving (clamped) option, not nothing.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("does not resurrect a stale highlight when the list empties and regrows", () => {
    const three = [
      { value: "a", hint: "branch" },
      { value: "b", hint: "branch" },
      { value: "c", hint: "branch" },
    ];
    const { input, rerender } = setup({ items: three });
    fireEvent.focus(input);
    // Highlight index 2, then let the list empty out (e.g. async refresh) with
    // no typing/arrowing in between, then repopulate to the original length.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    rerender({ items: [] });
    expect(input).not.toHaveAttribute("aria-activedescendant");
    rerender({ items: three });
    // The old index-2 highlight must NOT come back on its own; the input opens
    // unhighlighted until the user navigates again.
    expect(input).not.toHaveAttribute("aria-activedescendant");
    expect(screen.queryByRole("option", { selected: true })).not.toBeInTheDocument();
  });

  it("closes on Escape and renders nothing without items", () => {
    const { input } = setup();
    fireEvent.focus(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    const empty = setup({ items: [], ariaLabel: "Empty" });
    fireEvent.focus(empty.input);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
