import { useRef, useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useFocusTrap } from "./useFocusTrap";

function Trapped({ active = true, withAutoFocus = false }: { active?: boolean; withAutoFocus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(active, ref);
  return (
    <div ref={ref} role="dialog" tabIndex={-1} aria-label="trap">
      <button>first</button>
      <input aria-label="mid" autoFocus={withAutoFocus} />
      <button>last</button>
    </div>
  );
}

afterEach(cleanup);

describe("useFocusTrap", () => {
  it("moves focus to the first focusable when nothing inside is focused", () => {
    render(<Trapped />);
    expect(screen.getByRole("button", { name: "first" })).toHaveFocus();
  });

  it("honours a child's autoFocus instead of overriding it", () => {
    render(<Trapped withAutoFocus />);
    expect(screen.getByRole("textbox", { name: "mid" })).toHaveFocus();
  });

  it("wraps Tab from the last element back to the first", () => {
    render(<Trapped />);
    const last = screen.getByRole("button", { name: "last" });
    last.focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(screen.getByRole("button", { name: "first" })).toHaveFocus();
  });

  it("wraps Shift+Tab from the first element to the last", () => {
    render(<Trapped />);
    const first = screen.getByRole("button", { name: "first" });
    first.focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "last" })).toHaveFocus();
  });

  it("pulls focus back inside if it escaped the container", () => {
    render(
      <>
        <button>outside</button>
        <Trapped />
      </>,
    );
    const outside = screen.getByRole("button", { name: "outside" });
    outside.focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(screen.getByRole("button", { name: "first" })).toHaveFocus();
  });

  it("does nothing while inactive", () => {
    render(<Trapped active={false} />);
    expect(screen.getByRole("button", { name: "first" })).not.toHaveFocus();
  });

  it("restores focus to the opener on deactivation", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen((o) => !o)}>opener</button>
          {open && <Trapped />}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "opener" });
    // Focus the opener BEFORE the trap mounts, so it is what the trap captures
    // as previouslyFocused — otherwise the restore assertion is vacuous.
    opener.focus();
    fireEvent.click(opener); // open → trap mounts, seeds focus inside
    expect(screen.getByRole("button", { name: "first" })).toHaveFocus();
    fireEvent.click(opener); // close → trap unmounts, restores to opener
    expect(opener).toHaveFocus();
  });
});
