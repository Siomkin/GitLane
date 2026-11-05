import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { SegmentedControl } from "./SegmentedControl";

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
] as const;

function Harness({ initial = "a" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <SegmentedControl value={value} options={OPTIONS} onChange={setValue} ariaLabel="Pick one" />;
}

describe("SegmentedControl", () => {
  it("renders a radiogroup whose selected radio is aria-checked and focusable", () => {
    render(<Harness />);
    expect(screen.getByRole("radiogroup", { name: "Pick one" })).toBeInTheDocument();
    const alpha = screen.getByRole("radio", { name: "Alpha" });
    expect(alpha).toHaveAttribute("aria-checked", "true");
    expect(alpha).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Beta" })).toHaveAttribute("tabindex", "-1");
  });

  it("selects on click", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: "Gamma" }));
    expect(screen.getByRole("radio", { name: "Gamma" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Alpha" })).toHaveAttribute("aria-checked", "false");
  });

  it("moves and selects with the arrow keys, wrapping, and Home/End", () => {
    render(<Harness />);
    const radio = (name: string) => screen.getByRole("radio", { name });
    fireEvent.keyDown(radio("Alpha"), { key: "ArrowRight" });
    expect(radio("Beta")).toHaveAttribute("aria-checked", "true");
    expect(radio("Beta")).toHaveFocus();
    fireEvent.keyDown(radio("Beta"), { key: "ArrowDown" });
    fireEvent.keyDown(radio("Gamma"), { key: "ArrowRight" });
    expect(radio("Alpha")).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radio("Alpha"), { key: "ArrowLeft" });
    expect(radio("Gamma")).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radio("Gamma"), { key: "ArrowUp" });
    expect(radio("Beta")).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radio("Beta"), { key: "Home" });
    expect(radio("Alpha")).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radio("Alpha"), { key: "End" });
    expect(radio("Gamma")).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radio("Gamma"), { key: "x" });
    expect(radio("Gamma")).toHaveAttribute("aria-checked", "true");
  });

  it("keeps the first option tabbable when nothing is selected", () => {
    render(<Harness initial="none" />);
    expect(screen.getByRole("radio", { name: "Alpha" })).toHaveAttribute("tabindex", "0");
  });
});
