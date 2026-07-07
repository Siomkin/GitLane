import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The dialog subscribes to the backend's `handoff-progress` events; capture the
// handlers so tests can drive the checklist.
const { progressListeners } = vi.hoisted(() => ({
  progressListeners: [] as Array<(e: { payload: { step: string } }) => void>,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, cb: (e: { payload: { step: string } }) => void) => {
    progressListeners.push(cb);
    return () => {
      const i = progressListeners.indexOf(cb);
      if (i >= 0) progressListeners.splice(i, 1);
    };
  }),
}));

import { HandoffDialog } from "./HandoffDialog";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useNotifications } from "@/store/notifications";
import type { WorktreeInfo } from "@/lib/api";

const worktrees: WorktreeInfo[] = [
  { name: "repo", path: "/work/repo", branch: "main", isMain: true },
  { name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false },
  { name: "repo-scratch", path: "/work/repo-scratch", branch: null, isMain: false },
];

const openDialog = () =>
  useUi.setState({
    handoff: { branch: "feature", sourcePath: "/work/repo-feature", sourceChanges: 2 },
  });

const emitStep = (step: string) =>
  act(() => {
    for (const cb of [...progressListeners]) cb({ payload: { step } });
  });

describe("HandoffDialog", () => {
  beforeEach(() => {
    progressListeners.length = 0;
    useUi.setState({ handoff: null });
    useNotifications.setState({ toasts: [] });
    useRepo.setState({ worktrees });
  });

  it("offers the other worktrees as destinations and names the carried changes", () => {
    openDialog();
    render(<HandoffDialog />);
    const select = screen.getByRole("combobox", { name: "Destination workspace" });
    // Source is excluded; main first, then the detached scratch worktree.
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.value)).toEqual([
      "/work/repo",
      "/work/repo-scratch",
    ]);
    expect(screen.getByText(/2 uncommitted changes .* carried/)).toBeInTheDocument();
  });

  it("runs the carrying move and ticks the checklist off progress events", async () => {
    let resolveMove!: (msg: string) => void;
    const moveBranchToWorktree = vi.fn(
      () => new Promise<string>((resolve) => (resolveMove = resolve)),
    );
    useRepo.setState({ moveBranchToWorktree });
    openDialog();
    render(<HandoffDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Hand off" }));
    await waitFor(() =>
      expect(moveBranchToWorktree).toHaveBeenCalledWith(
        "feature",
        "/work/repo-feature",
        "/work/repo",
        true,
      ),
    );
    // The checklist renders with the first row active.
    expect(screen.getByText("Checking out feature in main")).toBeInTheDocument();
    const statuses = () =>
      Array.from(document.querySelectorAll("[data-status]")).map((el) =>
        el.getAttribute("data-status"),
      );
    expect(statuses()).toEqual(["active", "pending", "pending", "pending", "pending"]);

    // A clean source skips the stash step: reaching `checkout` folds rows 0-1 in.
    emitStep("checkout");
    expect(statuses()).toEqual(["done", "done", "active", "pending", "pending"]);

    // Resolution swaps to the success screen (title names the destination
    // captured at submit; the backend message is the summary line).
    await act(async () => resolveMove("Handed off feature to main with 2 carried changes"));
    expect(screen.getByText("Handed off to main")).toBeInTheDocument();
    expect(
      screen.getByText("Handed off feature to main with 2 carried changes"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(useUi.getState().handoff).toBeNull();
  });

  it("starts a single run on a rapid double-click", async () => {
    let resolveMove!: (msg: string) => void;
    const moveBranchToWorktree = vi.fn(
      () => new Promise<string>((resolve) => (resolveMove = resolve)),
    );
    useRepo.setState({ moveBranchToWorktree });
    openDialog();
    render(<HandoffDialog />);

    // Both clicks land before the running re-render — the synchronous in-flight
    // latch must swallow the second (the store guard would surface it as a
    // spurious error screen).
    const button = screen.getByRole("button", { name: "Hand off" });
    fireEvent.click(button);
    fireEvent.click(button);
    // The run awaits the event subscription before invoking — wait for the move
    // to actually start before resolving it.
    await waitFor(() => expect(moveBranchToWorktree).toHaveBeenCalledTimes(1));
    await act(async () => resolveMove("Moved feature to main"));
    expect(moveBranchToWorktree).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Handed off to main")).toBeInTheDocument();
  });

  it("shows the failure inline when the move rejects", async () => {
    useRepo.setState({
      moveBranchToWorktree: vi.fn().mockRejectedValue(new Error("Couldn't detach the source worktree")),
    });
    openDialog();
    render(<HandoffDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Hand off" }));
    await waitFor(() => expect(screen.getByText("Hand-off failed")).toBeInTheDocument());
    expect(screen.getByText(/Couldn't detach the source worktree/)).toBeInTheDocument();
  });

  it("falls back to a toast when the dialog was closed mid-run", async () => {
    let resolveMove!: (msg: string) => void;
    useRepo.setState({
      moveBranchToWorktree: vi.fn(() => new Promise<string>((resolve) => (resolveMove = resolve))),
    });
    openDialog();
    render(<HandoffDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Hand off" }));
    await waitFor(() => expect(progressListeners.length).toBe(1));

    // Close while the move is still running — the run must keep going.
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(useUi.getState().handoff).toBeNull();

    await act(async () => resolveMove("Moved feature to main"));
    expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toBe("Moved feature to main");
  });
});
