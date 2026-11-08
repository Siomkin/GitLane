import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { Toasts } from "./ToastStack";
import { useNotifications } from "@/store/notifications";

beforeEach(() => {
  useNotifications.setState({ toasts: [], leaving: [], paused: false });
});

describe("Toasts (stack)", () => {
  it("renders nothing when empty", () => {
    const { container } = render(<Toasts />);
    expect(container.firstChild).toBeNull();
  });

  it("renders title, body, and an accessible status role", () => {
    useNotifications.getState().notify({ kind: "success", title: "Pushed 3 commits", body: "to origin/main" });
    render(<Toasts />);
    expect(screen.getByText("Pushed 3 commits")).toBeInTheDocument();
    expect(screen.getByText("to origin/main")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("uses alert semantics for errors and keeps a dismiss button", () => {
    useNotifications.getState().notify({ kind: "error", title: "Push rejected" });
    render(<Toasts />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("draws no left strip or countdown bar", () => {
    useNotifications.getState().notify({ kind: "success", title: "Saved" });
    render(<Toasts />);
    // Only the status chip and close button remain; happy-dom drops the color-mix glow itself.
    expect(screen.getByRole("status").querySelectorAll("span[aria-hidden], span.absolute")).toHaveLength(0);
  });

  it("keeps a dismissed card inert in place until its exit ends", () => {
    vi.useFakeTimers();
    try {
      useNotifications.getState().notify({ kind: "error", title: "Push rejected" });
      const { container } = render(<Toasts />);
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

      const slot = screen.getByText("Push rejected").closest(".nf-slot");
      expect(slot).toHaveAttribute("data-leaving");
      expect(slot).toHaveAttribute("inert");

      act(() => void vi.advanceTimersByTime(320));
      expect(container.firstChild).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs an action and dismisses the toast", () => {
    const onClick = vi.fn();
    useNotifications
      .getState()
      .notify({ kind: "warning", title: "Uncommitted changes", actions: [{ label: "Stash", onClick }] });
    render(<Toasts />);
    fireEvent.click(screen.getByRole("button", { name: "Stash" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("shows a percentage and no dismiss button for a determinate progress toast", () => {
    useNotifications.getState().notify({ kind: "progress", title: "Pushing to origin…", progress: 0.64 });
    render(<Toasts />);
    expect(screen.getByText("64%")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("pauses countdowns while the pointer is over the stack", () => {
    useNotifications.getState().notify({ title: "hi" });
    render(<Toasts />);
    const stack = screen.getByText("hi").closest("div[class*='fixed']") as HTMLElement;
    fireEvent.mouseEnter(stack);
    expect(useNotifications.getState().paused).toBe(true);
    fireEvent.mouseLeave(stack);
    expect(useNotifications.getState().paused).toBe(false);
  });
});
