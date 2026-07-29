import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useBackdropDismiss } from "./useBackdropDismiss";

function Modal({ onDismiss }: { onDismiss?: () => void }) {
  const backdrop = useBackdropDismiss();
  return (
    <div
      data-testid="backdrop"
      onMouseDown={backdrop.onMouseDown}
      onClick={backdrop.onClick(onDismiss)}
    >
      <div onClick={(e) => e.stopPropagation()}>
        <input aria-label="name" defaultValue="admin-dark-theme" />
      </div>
    </div>
  );
}

describe("useBackdropDismiss", () => {
  it("dismisses on a click that starts on the backdrop", () => {
    const onDismiss = vi.fn();
    render(<Modal onDismiss={onDismiss} />);
    const backdrop = screen.getByTestId("backdrop");
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("ignores the click a selection dragged out of the panel produces", () => {
    // Press inside the field, release on the backdrop: the browser dispatches
    // the click on the common ancestor, past the panel's stopPropagation.
    const onDismiss = vi.fn();
    render(<Modal onDismiss={onDismiss} />);
    fireEvent.mouseDown(screen.getByLabelText("name"));
    fireEvent.click(screen.getByTestId("backdrop"));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("doesn't let a suppressed drag block the next click-only dismiss", () => {
    // The flag describes one interaction: after the drag's click is suppressed,
    // a later click that arrives without a press of its own must not inherit it.
    const onDismiss = vi.fn();
    render(<Modal onDismiss={onDismiss} />);
    const backdrop = screen.getByTestId("backdrop");
    fireEvent.mouseDown(screen.getByLabelText("name"));
    fireEvent.click(backdrop);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.click(backdrop);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("clears the flag even while dismissal is blocked", () => {
    // A press inside during a running operation must not leave the backdrop
    // dead once the dialog becomes dismissable again.
    const onDismiss = vi.fn();
    const { rerender } = render(<Modal onDismiss={undefined} />);
    fireEvent.mouseDown(screen.getByLabelText("name"));
    fireEvent.click(screen.getByTestId("backdrop"));

    rerender(<Modal onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId("backdrop"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("still dismisses on a click with no preceding mousedown", () => {
    // Synthetic and AT-generated clicks arrive without a press.
    const onDismiss = vi.fn();
    render(<Modal onDismiss={onDismiss} />);
    fireEvent.click(screen.getByTestId("backdrop"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does nothing when dismissal is blocked", () => {
    render(<Modal onDismiss={undefined} />);
    const backdrop = screen.getByTestId("backdrop");
    fireEvent.mouseDown(backdrop);
    expect(() => fireEvent.click(backdrop)).not.toThrow();
  });
});
