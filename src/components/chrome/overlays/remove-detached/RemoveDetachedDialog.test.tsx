import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RepoSummary, WorktreeInfo } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useNotifications } from "@/store/notifications";
import { RemoveDetachedDialog } from "./RemoveDetachedDialog";

const wt = (over: Partial<WorktreeInfo>): WorktreeInfo => ({
  name: "wt",
  path: "/work/wt",
  branch: null,
  isMain: false,
  ...over,
});

const summary = (path: string): RepoSummary => ({
  path,
  workdir: path,
  headBranch: "main",
  headOid: "c1",
  detached: false,
});

const a = wt({ name: "a", path: "/work/a" });
const b = wt({ name: "b", path: "/work/b", locked: true });

const open = (targets: WorktreeInfo[]) => useUi.setState({ removeDetached: { targets } });

const clickRemove = () => fireEvent.click(screen.getByRole("button", { name: /^Remove \d/ }));

beforeEach(() => {
  useUi.setState({ removeDetached: null, removeDetachedRunning: false });
  useNotifications.setState({ toasts: [] });
  useRepo.setState({ removeWorktree: vi.fn().mockResolvedValue("Removed") });
});

describe("RemoveDetachedDialog", () => {
  it("renders nothing when no sweep is pending", () => {
    const { container } = render(<RemoveDetachedDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("previews every target path and removes nothing before the user confirms", () => {
    const removeWorktree = vi.fn().mockResolvedValue("Removed");
    useRepo.setState({ removeWorktree });
    open([a, b]);
    render(<RemoveDetachedDialog />);

    expect(screen.getByText("Remove 2 detached worktrees")).toBeInTheDocument();
    expect(screen.getByText("/work/a")).toBeInTheDocument();
    expect(screen.getByText("/work/b")).toBeInTheDocument();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("removes each target in order, never forcing, then shows the summary", async () => {
    const removeWorktree = vi.fn().mockResolvedValue("Removed");
    useRepo.setState({ removeWorktree });
    open([a, b]);
    render(<RemoveDetachedDialog />);

    clickRemove();

    await waitFor(() => expect(removeWorktree).toHaveBeenCalledTimes(2));
    // The bulk sweep never forces — git's dirty-worktree protection must apply,
    // and locked worktrees are excluded from the removable set upstream.
    expect(removeWorktree).toHaveBeenNthCalledWith(1, "/work/a", false);
    expect(removeWorktree).toHaveBeenNthCalledWith(2, "/work/b", false);
    await waitFor(() =>
      expect(screen.getAllByText("Removed 2 detached worktrees").length).toBeGreaterThan(0),
    );
    // The header restates the clean-sweep outcome (no failure heading).
    expect(screen.queryByText(/couldn/i)).not.toBeInTheDocument();
  });

  it("keeps sweeping after a failed removal and flags the failed row in the summary", async () => {
    const removeWorktree = vi
      .fn()
      .mockRejectedValueOnce(new Error("dirty worktree"))
      .mockResolvedValueOnce("Removed");
    useRepo.setState({ removeWorktree });
    open([a, b]);
    render(<RemoveDetachedDialog />);

    clickRemove();

    await waitFor(() => expect(removeWorktree).toHaveBeenCalledTimes(2));
    // Both are attempted despite the first failing; the summary reports the split
    // and surfaces the first error.
    await waitFor(() =>
      expect(screen.getByText(/Removed 1 of 2 detached worktrees — .*dirty worktree/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/couldn/i)).toBeInTheDocument();
    // The failed target's checklist row carries the failed status.
    const failedRow = screen.getByText("a").closest("[data-status]");
    expect(failedRow).toHaveAttribute("data-status", "failed");
  });

  it("stops the sweep when the repo switches under it, leaving the rest in place", async () => {
    let resolveFirst!: (msg: string) => void;
    const removeWorktree = vi
      .fn()
      .mockImplementationOnce(() => new Promise<string>((res) => { resolveFirst = res; }))
      .mockResolvedValue("Removed");
    useRepo.setState({ summary: summary("/repo"), removeWorktree });
    open([a, b]);
    render(<RemoveDetachedDialog />);

    clickRemove();
    await waitFor(() => expect(removeWorktree).toHaveBeenCalledTimes(1));

    // A repo switch lands mid-sweep (the sweep is pinned to /repo). The second
    // target must NOT be removed against the new repo.
    act(() => useRepo.setState({ summary: summary("/other") }));
    resolveFirst("Removed");

    await waitFor(() =>
      expect(screen.getByText(/Removed 1 of 2 detached worktrees — Repository changed/)).toBeInTheDocument(),
    );
    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(removeWorktree).toHaveBeenCalledWith("/work/a", false);
  });

  it("blocks a second sweep while one is already running", () => {
    useUi.setState({ removeDetachedRunning: true });
    open([a]);
    render(<RemoveDetachedDialog />);

    expect(screen.getByRole("button", { name: /^Remove \d/ })).toBeDisabled();
    expect(screen.getByText(/Another sweep is still finishing/)).toBeInTheDocument();
  });

  it("finishes in the background and toasts the summary when closed mid-run", async () => {
    let resolveRemove!: (msg: string) => void;
    const removeWorktree = vi.fn().mockImplementation(
      () => new Promise<string>((res) => { resolveRemove = res; }),
    );
    useRepo.setState({ removeWorktree });
    open([a]);
    const { rerender } = render(<RemoveDetachedDialog />);

    clickRemove();
    await waitFor(() => expect(removeWorktree).toHaveBeenCalledTimes(1));

    // Close the dialog mid-run — the body unmounts but the sweep keeps going.
    useUi.setState({ removeDetached: null });
    rerender(<RemoveDetachedDialog />);
    resolveRemove("Removed");

    await waitFor(() =>
      expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toBe("Removed 1 detached worktree"),
    );
  });
});
