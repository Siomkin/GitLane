import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { Select } from "./Select";

describe("Select", () => {
  it("strips the native chrome with BOTH the prefixed and unprefixed property", () => {
    // The whole point of the primitive (GL-215). Tailwind v4 emits only the
    // unprefixed `appearance`, which older WebKitGTK ignores — drop the prefixed
    // form and the GTK widget comes back, light-on-dark, and the fix silently
    // no-ops on the one engine it exists for.
    render(
      <Select aria-label="Host">
        <option value="a">A</option>
      </Select>,
    );
    const cls = screen.getByRole("combobox").className;
    expect(cls).toContain("appearance-none");
    expect(cls).toContain("[-webkit-appearance:none]");
  });

  it("stays a real <select>: label, value, and change events all work", () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="Base branch" value="main" onChange={onChange}>
        <option value="main">main</option>
        <option value="dev">dev</option>
      </Select>,
    );
    const el = screen.getByRole("combobox", { name: "Base branch" }) as HTMLSelectElement;
    expect(el.value).toBe("main");
    fireEvent.change(el, { target: { value: "dev" } });
    expect(onChange).toHaveBeenCalled();
  });

  it("keeps layout classes off the control and control classes off the wrapper", () => {
    // The chevron is absolutely positioned, so the wrapper owns the row layout
    // (flex-1 / margins) while the control owns its own box.
    const { container } = render(
      <Select aria-label="Host" wrapperClassName="min-w-0 flex-1" className="h-9 bg-white">
        <option value="a">A</option>
      </Select>,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("relative");
    expect(wrapper.className).toContain("flex-1");

    const control = screen.getByRole("combobox");
    expect(control.className).toContain("h-9");
    expect(control.className).not.toContain("flex-1");
  });

  it("reserves room for the chevron and hides it from assistive tech", () => {
    const { container } = render(
      <Select aria-label="Host">
        <option value="a">A</option>
      </Select>,
    );
    // Without the right padding the chevron sits on top of a long option label.
    expect(screen.getByRole("combobox").className).toContain("pr-7");
    const chevron = container.querySelector("svg");
    expect(chevron).toHaveAttribute("aria-hidden");
    // Decorative only — a click must reach the control beneath it.
    expect(chevron?.getAttribute("class")).toContain("pointer-events-none");
  });
});
