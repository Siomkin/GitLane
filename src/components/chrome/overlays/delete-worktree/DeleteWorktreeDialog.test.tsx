import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The dialog subscribes to `delete-worktree-progress`; capture the handlers so
// tests can drive the checklist. The IPC boundary is mocked at `invoke` level
// (the canonical pattern — see src/test/README.md), so the real api wrappers and
// stores run.
const { progressListeners, invokeMock, listenGate } = vi.hoisted(() => ({
  progressListeners: [] as Array<(e: { payload: { step: string } }) => void>,
  invokeMock: vi.fn(),
  // When set, `listen()` awaits this before registering — lets a test hold the
  // listener-setup window open and interleave a repo switch (GL-107 race repro).
  listenGate: { current: null as Promise<void> | null },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, cb: (e: { payload: { step: string } }) => void) => {
    if (listenGate.current) await listenGate.current;
    progressListeners.push(cb);
    return () => {
      const i = progressListeners.indexOf(cb);
      if (i >= 0) progressListeners.splice(i, 1);
    };
  }),
}));

import { DeleteWorktreeDialog } from "./DeleteWorktreeDialog";
import { useRepo } from "@/store/repo";
import { beginPublishedRepoSession } from "@/store/repoRequests";
import { useUi } from "@/store/ui";
import { useNotifications } from "@/store/notifications";

const preview = {
  summary: "Delete local branch feature",
  details: [
    "Local branch feature points at abc1234.",
    "Commits ahead of current HEAD: abc1234 wip",
  ],
  warnings: [
    "The branch ref is removed; commits survive only while another ref or the reflog keeps them reachable.",
  ],
  expectedOid: "feature-preview-oid",
};

const worktreePreview = {
  summary: "Remove the linked worktree repo-feature?",
  details: ["The linked worktree at /work/repo-feature will be removed."],
  warnings: [],
  expectedState: "v1:worktree-lease",
  requiresForce: false,
  locked: false,
  branch: "feature",
  headOid: "feature-preview-oid",
  dirty: { modified: 0, untracked: 0, ignored: 0 },
};

/** Wire the IPC mock: dual previews plus a controllable delete. */
const arm = () => {
  let resolveDelete!: (msg: string) => void;
  let rejectDelete!: (e: Error) => void;
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "preview_delete_branch") return preview;
    if (cmd === "preview_remove_worktree") return worktreePreview;
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
    listenGate.current = null;
    useUi.setState({ deleteWorktree: null, deleteWorktreeRunning: false });
    useNotifications.setState({ toasts: [] });
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

  it("does not refresh the new repo when the user switches repos before the delete resolves", async () => {
    const del = arm();
    const refresh = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ summary: { path: "/work/repo" } as never, refresh: refresh as never });
    openDialog();
    render(<DeleteWorktreeDialog />);
    const button = await screen.findByRole("button", { name: "Delete anyway" });
    await waitFor(() => expect(button).not.toBeDisabled());

    fireEvent.click(button);
    await waitFor(() => expect(progressListeners.length).toBe(1));
    // Simulate a repo switch landing while the delete IPC is still in flight (the
    // delete already targeted /work/repo; only the post-op refresh is at risk).
    useRepo.setState({ summary: { path: "/work/other" } as never });

    await act(async () => del.resolve("Deleted feature and its worktree"));
    // The pinned repo no longer matches the active one, so the refresh is skipped
    // — refreshing /work/other would reload the wrong graph.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not refresh a reopened same-path repo session after the delete resolves", async () => {
    const del = arm();
    const refresh = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ summary: { path: "/work/repo" } as never, refresh: refresh as never });
    openDialog();
    render(<DeleteWorktreeDialog />);
    const button = await screen.findByRole("button", { name: "Delete anyway" });
    await waitFor(() => expect(button).not.toBeDisabled());

    fireEvent.click(button);
    await waitFor(() => expect(progressListeners.length).toBe(1));
    // A -> B -> A has the same displayed path at settlement, but it is a new
    // published session and must not inherit the old dialog's refresh.
    beginPublishedRepoSession();
    useRepo.setState({ summary: { path: "/work/other" } as never });
    beginPublishedRepoSession();
    useRepo.setState({ summary: { path: "/work/repo" } as never });

    await act(async () => del.resolve("Deleted feature and its worktree"));

    expect(refresh).not.toHaveBeenCalled();
  });

  it("pins the delete to the starting repo when a switch lands during listener setup", async () => {
    const del = arm();
    useRepo.setState({
      summary: { path: "/work/repo" } as never,
      refresh: vi.fn().mockResolvedValue(undefined) as never,
    });
    // Hold the listener-setup window open so a repo switch can interleave between
    // the click and the delete invoke (the exact race the reviewer flagged).
    let openGate!: () => void;
    listenGate.current = new Promise<void>((res) => (openGate = res));
    openDialog();
    render(<DeleteWorktreeDialog />);
    const button = await screen.findByRole("button", { name: "Delete anyway" });
    await waitFor(() => expect(button).not.toBeDisabled());

    fireEvent.click(button);
    // Repo switch lands while listen() is still pending (loadRepo would close the
    // dialog; the background run keeps going). Then let the listener finish.
    useRepo.setState({ summary: { path: "/work/other" } as never });
    await act(async () => {
      openGate();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(invokeMock.mock.calls.some(([cmd]) => cmd === "delete_branch_with_worktree")).toBe(true),
    );
    // The delete targets the repo the dialog started on (/work/repo), never the
    // now-active /work/other.
    const call = invokeMock.mock.calls.find(([cmd]) => cmd === "delete_branch_with_worktree");
    expect(call?.[1]).toMatchObject({
      path: "/work/repo",
      branch: "feature",
      expectedOid: "feature-preview-oid",
    });
    await act(async () => del.resolve("Deleted feature and its worktree"));
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

  it("stays silent when the dialog was closed mid-run on success", async () => {
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
    await waitFor(() => expect(useUi.getState().deleteWorktreeRunning).toBe(false));
    expect(useNotifications.getState().toasts).toHaveLength(0);
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
    // background) and reopen a fresh dialog — its hook has inFlight=false, so the
    // store latch is what stops a second invoke.
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    first.unmount();
    openDialog();
    render(<DeleteWorktreeDialog />);
    // Even once the preview has loaded, the button stays disabled with a visible
    // reason (not a silent no-op) while the first delete is still running.
    await screen.findByText(/Commits ahead of current HEAD/);
    const secondButton = screen.getByRole("button", { name: "Delete anyway" });
    expect(secondButton).toBeDisabled();
    expect(screen.getByText(/Another delete is still finishing/)).toBeInTheDocument();
    fireEvent.click(secondButton);

    // Still exactly one delete IPC — the disabled button + store latch both hold.
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "delete_branch_with_worktree"),
    ).toHaveLength(1);
    // Let the first delete settle so the latch clears and the button frees up.
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
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });
});
