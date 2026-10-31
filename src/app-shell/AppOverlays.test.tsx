// Every global overlay renders behind its own boundary, so one crashing dialog
// can't unmount its neighbours (and, before this, the whole window).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMock = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

vi.mock("@/features/pull-requests/create-pr", async () => {
  const { useUi } = await import("@/store/ui");
  return {
    CreatePrDialog: () => {
      if (!useUi((s) => s.createPrOpen)) return null;
      throw new Error("create-pr exploded");
    },
  };
});

import { useUi } from "@/store/ui";
import { AppOverlays, OVERLAYS } from "./AppOverlays";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  useUi.setState({ createPrOpen: false });
});

describe("AppOverlays", () => {
  it("registers each overlay once, with a close unless it is always present", () => {
    const ids = OVERLAYS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    const silent = OVERLAYS.filter((o) => o.close === null).map((o) => o.id);
    expect(silent).toEqual(["toasts", "tooltip"]);
  });

  it("contains a crashing dialog and closes it through its own flag", async () => {
    render(
      <>
        <div>workspace</div>
        <AppOverlays />
      </>,
    );
    act(() => useUi.getState().openCreatePr());

    expect(screen.getByRole("alert")).toHaveTextContent("create-pr exploded");
    expect(screen.getByText("workspace")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(useUi.getState().createPrOpen).toBe(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("drops the error card when the dialog is closed elsewhere", () => {
    render(<AppOverlays />);
    act(() => useUi.getState().openCreatePr());
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // A repo switch closes the form without going through the card.
    act(() => useUi.setState({ createPrOpen: false }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the open-remote dialog while requested and closes it through its registry entry", () => {
    render(<AppOverlays />);
    act(() => useUi.getState().openOpenRemote({ onOpen: () => {} }));
    expect(screen.getByRole("dialog", { name: "Open remote repository" })).toBeInTheDocument();

    const entry = OVERLAYS.find((o) => o.id === "open-remote");
    act(() => entry?.close?.());
    expect(useUi.getState().openRemote).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Open remote repository" })).not.toBeInTheDocument();
  });

  it("gives every closable overlay an open flag", () => {
    const missing = OVERLAYS.filter((o) => o.close !== null && !o.isOpen).map((o) => o.id);
    expect(missing).toEqual([]);
  });
});
