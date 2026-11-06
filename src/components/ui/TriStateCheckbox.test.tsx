import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TriStateCheckbox } from "./TriStateCheckbox";

const box = () => screen.getByRole("checkbox");

describe("TriStateCheckbox", () => {
  it("hides an unchecked box until its row is hovered", () => {
    render(<TriStateCheckbox checked={false} label="Include a.ts" onChange={() => {}} />);
    expect(box()).toHaveClass("border-transparent", "group-hover:border-black/25");
    expect(box()).not.toHaveClass("bg-[var(--accent)]/10");
    expect(box().querySelector("svg")).toBeNull();
  });

  it("shows a checked box as a soft accent tint with a check", () => {
    render(<TriStateCheckbox checked label="Exclude a.ts" onChange={() => {}} />);
    expect(box()).toHaveAttribute("aria-checked", "true");
    expect(box()).toHaveClass("bg-[var(--accent)]/10", "border-[color:var(--accent)]/40");
    expect(box()).not.toHaveClass("bg-[var(--accent)]");
    expect(box().querySelector("svg")).not.toBeNull();
  });

  it("shows a dash when mixed", () => {
    render(<TriStateCheckbox checked="mixed" label="Include all" onChange={() => {}} />);
    expect(box()).toHaveAttribute("aria-checked", "mixed");
    expect(box()).toHaveClass("bg-[var(--accent)]/10");
    expect(box().querySelector("svg")).toBeNull();
    expect(box().querySelector("span")).not.toBeNull();
  });

  it("ignores clicks when disabled and explains why", () => {
    const onChange = vi.fn();
    render(
      <TriStateCheckbox checked={false} label="Include a.ts" onChange={onChange} disabledReason="Busy" />,
    );
    fireEvent.click(box());
    expect(onChange).not.toHaveBeenCalled();
    expect(box()).toHaveAttribute("title", "Busy");
  });
});
