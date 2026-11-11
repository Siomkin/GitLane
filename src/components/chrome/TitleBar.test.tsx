// The tab strip's edge arrows: shown only on an edge that hides tabs, and each
// pages the strip toward its side.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyIpcInvoke } from "@/test/ipcFixtures";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { useRepo } from "@/store/repo";
import { summary } from "@/test/repoFixtures";
import { TitleBar } from "./TitleBar";

const real = useRepo.getState();
const scrollBy = vi.fn();

beforeEach(() => {
  invokeMock.mockImplementation(emptyIpcInvoke);
  useRepo.setState(real, true);
  useRepo.setState({ summary, openPaths: [summary.path, "/other"], recents: [], tabInfoByPath: {} });
  // happy-dom has no layout: every box reports a strip wider than its view.
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  Object.defineProperty(HTMLElement.prototype, "scrollBy", { configurable: true, value: scrollBy });
  scrollBy.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TitleBar tab strip arrows", () => {
  it("shows an arrow only on an edge that hides tabs and pages toward it", () => {
    render(<TitleBar />);
    expect(screen.queryByRole("button", { name: "Scroll tabs left" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Scroll tabs right" }));
    expect(scrollBy).toHaveBeenLastCalledWith({ left: 320, behavior: "smooth" });

    const scroller = scrollBy.mock.contexts[0] as HTMLElement;
    scroller.scrollLeft = 600;
    act(() => scroller.dispatchEvent(new Event("scroll")));
    expect(screen.queryByRole("button", { name: "Scroll tabs right" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Scroll tabs left" }));
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -320, behavior: "smooth" });
  });
});
