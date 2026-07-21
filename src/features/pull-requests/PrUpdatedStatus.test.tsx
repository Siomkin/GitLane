import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { PrUpdatedStatus } from "./PrUpdatedStatus";

afterEach(() => {
  vi.useRealTimers();
});

describe("PrUpdatedStatus", () => {
  it("preserves loading and not-loaded copy", () => {
    const { rerender } = render(
      <PrUpdatedStatus loading={false} fetchedAt={null} />,
    );

    expect(screen.getByText("Not loaded")).toBeInTheDocument();

    rerender(<PrUpdatedStatus loading fetchedAt={null} />);

    expect(screen.getByText("Updating…")).toBeInTheDocument();
  });

  it("ticks from the latest fetch time and cleans up its interval", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { rerender, unmount } = render(
      <PrUpdatedStatus loading={false} fetchedAt={Date.now()} />,
    );

    expect(screen.getByText("Updated 0s ago")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByText("Updated 3s ago")).toBeInTheDocument();

    vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
    rerender(<PrUpdatedStatus loading={false} fetchedAt={Date.now()} />);

    expect(screen.getByText("Updated 0s ago")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);

    rerender(<PrUpdatedStatus loading={false} fetchedAt={null} />);

    expect(screen.getByText("Not loaded")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);

    rerender(<PrUpdatedStatus loading={false} fetchedAt={Date.now()} />);

    expect(screen.getByText("Updated 0s ago")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
