import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The dialog subscribes to `delete-worktree-progress`; capture the handlers so
// tests can drive the checklist. The IPC boundary is mocked at `invoke` level
// (the canonical pattern — see src/test/README.md), so the real api wrappers and
// stores run.
const { progressListeners, invokeMock } = vi.hoisted(() => ({
  progressListeners: [] as Array<(e: { payload: { step: string } }) => void>,
  invokeMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, cb: (e: { payload: { step: string } }) => void) => {
    progressListeners.push(cb);
    return () => {
      const i = progressListeners.indexOf(cb);
      if (i >= 0) progressListeners.splice(i, 1);
    };
  }),
}));

import { DeleteWorktreeDialog } from "./DeleteWorktreeDialog";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";

const preview = {
  summary: "Delete local branch feature",
  details: [
    "Local branch feature points at abc1234.",
    "Commits ahead of current HEAD: abc1234 wip",
  ],
  warnings: [
    "The branch ref is removed; commits survive only while another ref or the reflog keeps them reachable.",
  ],
};

/** Wire the IPC mock: a preview plus a controllable delete. */
const arm = () => {
  let resolveDelete!: (msg: string) => void;
  let rejectDelete!: (e: Error) => void;
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "preview_delete_branch") return preview;
    if (cmd === "delete_branch_with_worktree")
      return new Promise((resolve, reject) => {
        resolveDelete = resolve;
        rejectDelete = reject;
      });
    return undefined;
  });
  return {
    resolve: (msg: string) => resolveDelete(msg),
    reject: (e: Error) => rejectDelete(e),
  };
};

const openDialog = () =>
  useUi.setState({
    deleteWorktree: { branch: "feature", worktreePath: "/work/repo-feature" },
  });

const emitStep = (step: string) =>
  act(() => {
    for (const cb of [...progressListeners]) cb({ payload: { step } });
  });

const statuses = () =>
  Array.from(document.querySelectorAll("[data-status]")).map((el) => el.getAttribute("data-status"));

describe("DeleteWorktreeDialog", () => {
  beforeEach(() => {
    progressListeners.length = 0;
    invokeMock.mockReset();
    useUi.setState({ deleteWorktree: null, deleteWorktreeRunning: false, toast: null });
    // An open repo + a stub refresh the run hook can await after the delete.
    useRepo.setState({
      summary: { path: "/work/repo" } as never,
      refresh: vi.fn().mockResolvedValue(undefined) as never,
    });
  });

  it("previews the impact, then ticks the checklist and lands on success", async () => {
    const del = arm();
    openDialog();
    render(<DeleteWorktreeDialog />);

    // Configure: the worktree leaf and the amber unmerged-commit warning render;
    // Delete is enabled only once the preview resolves (fail-closed).
    expect(screen.getByText("repo-feature")).toBeInTheDocument();
    const deleteBtn = await screen.findByRole("button", { name: "Delete anyway" });
    await waitFor(() => expect(deleteBtn).not.toBeDisabled());
    expect(screen.getByText(/Commits ahead of current HEAD: abc1234 wip/)).toBeInTheDocument();

    fireEvent.click(deleteBtn);
    await waitFor(() => expect(progressListeners.length).toBe(1));
    // The checklist renders with the first row active.
    expect(screen.getByText("Removing worktree")).toBeInTheDocument();
    expect(statuses()).toEqual(["active", "pending", "pending"]);

    emitStep("removeWorktree");
    emitStep("deleteBranch");
    expect(statuses()).toEqual(["done", "active", "pending"]);

    // Resolving the delete advances to the Refreshing row, then the awaited
    // refresh completes the run.
    await act(async () => del.resolve("Deleted feature and its worktree"));
    await waitFor(() => expect(screen.getByText("Deleted feature")).toBeInTheDocument());
    expect(screen.getByText("Deleted feature and its worktree")).toBeInTheDocument();
    expect(useRepo.getState().refresh).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(useUi.getState().deleteWorktree).toBeNull();
  });

  it("shows the failure inline when the delete rejects", async () => {
    const del = arm();
    openDialog();
    render(<DeleteWorktreeDialog />);
    const deleteBtn = await screen.findByRole("button", { name: "Delete anyway" });
    await waitFor(() => expect(deleteBtn).not.toBeDisabled());

    fireEvent.click(deleteBtn);
    await waitFor(() => expect(progressListeners.length).toBe(1));
    await act(async () => del.reject(new Error("branch is checked out elsewhere")));
    await waitFor(() => expect(screen.getByText("Couldn’t delete the branch")).toBeInTheDocument());
    expect(screen.getByText(/checked out elsewhere/)).toBeInTheDocument();
  });

  it("starts a single run on a rapid double-click", async () => {
    const del = arm();
    openDialog();
    render(<DeleteWorktreeDialog />);
    const button = await screen.findByRole("button", { name: "Delete anyway" });
    await waitFor(() => expect(button).not.toBeDisabled());

    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === "delete_branch_with_worktree"),
      ).toHaveLength(1),
    );
    await act(async () => del.resolve("Deleted feature and its worktree"));
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "delete_branch_with_worktree"),
    ).toHaveLength(1);
  });

  it("falls back to a toast when the dialog was closed mid-run", async () => {
    const del = arm();
    openDialog();
    render(<DeleteWorktreeDialog />);
    const button = await screen.findByRole("button", { name: "Delete anyway" });
    await waitFor(() => expect(button).not.toBeDisabled());

    fireEvent.click(button);
    await waitFor(() => expect(progressListeners.length).toBe(1));
    // Close while the delete is still running — the run must keep going.
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(useUi.getState().deleteWorktree).toBeNull();

    await act(async () => del.resolve("Deleted feature and its worktree"));
    await waitFor(() =>
      expect(useUi.getState().toast?.message).toBe("Deleted feature and its worktree"),
    );
  });

  it("a reopened dialog can't start a second delete while the first is still in flight", async () => {
    const del = arm();
    openDialog();
    const first = render(<DeleteWorktreeDialog />);
    const button = await screen.findByRole("button", { name: "Delete anyway" });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(progressListeners.length).toBe(1));
    expect(useUi.getState().deleteWorktreeRunning).toBe(true);

    // Close mid-run (the body unmounts; the delete keeps running in the
    // background) and reopen a fresh dialog — its hook has inFlight=false, so only
    // the store latch stops a second invoke.
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    first.unmount();
    openDialog();
    render(<DeleteWorktreeDialog />);
    const secondButton = await screen.findByRole("button", { name: "Delete anyway" });
    await waitFor(() => expect(secondButton).not.toBeDisabled());
    fireEvent.click(secondButton);

    // The store latch swallowed the second run — still exactly one delete IPC.
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "delete_branch_with_worktree"),
    ).toHaveLength(1);
    // Let the first delete settle so the latch clears.
    await act(async () => del.resolve("Deleted feature and its worktree"));
    expect(useUi.getState().deleteWorktreeRunning).toBe(false);
  });

  it("shows the success screen under StrictMode's dev double-mount", async () => {
    // main.tsx wraps the app in <React.StrictMode>, whose simulated
    // unmount+remount must not leave the run hook believing the dialog is closed
    // (a cleanup-only `mounted` effect would divert every success to a toast and
    // leave the checklist spinning forever).
    const del = arm();
    openDialog();
    render(
      <React.StrictMode>
        <DeleteWorktreeDialog />
      </React.StrictMode>,
    );
    const button = await screen.findByRole("button", { name: "Delete anyway" });
    await waitFor(() => expect(button).not.toBeDisabled());

    fireEvent.click(button);
    await waitFor(() => expect(progressListeners.length).toBeGreaterThan(0));
    await act(async () => del.resolve("Deleted feature and its worktree"));
    await waitFor(() => expect(screen.getByText("Deleted feature")).toBeInTheDocument());
    expect(useUi.getState().toast).toBeNull();
  });
});
