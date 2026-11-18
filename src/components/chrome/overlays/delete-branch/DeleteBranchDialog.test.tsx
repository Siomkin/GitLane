import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// Previews go through the real api wrappers (IPC mocked at `invoke`); the delete
// itself is the store's, swapped for controllable spies.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { StepOutcomeError } from "@/lib/gitError";
import { useNotifications } from "@/store/notifications";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import type { BranchDeleteOutcome } from "@/lib/api";
import { DeleteBranchDialog } from "./DeleteBranchDialog";
import { DONE_CLOSE_MS } from "@/components/chrome/overlays/progress";

const localPreview = {
  summary: "Delete local branch feature",
  details: ["Local branch feature points at abc1234."],
  warnings: ["Commits survive only while another ref keeps them reachable."],
  expectedOid: "local-preview-oid",
  unmergedCommits: [],
};
const remotePreview = {
  summary: "Delete feature on origin",
  details: ["Remote-tracking ref origin/feature currently points at def5678."],
  warnings: ["GitLane cannot recover a deleted server-side branch."],
};
const target = { remote: "origin", branch: "feature", oid: "remote-oid" };

const realRemoveBranch = useRepo.getState().removeBranch;
const realDeleteBranchAndRemote = useRepo.getState().deleteBranchAndRemote;

/** A spy that holds its promise open and exposes its step callback. */
function controllable() {
  let resolve!: (outcome: BranchDeleteOutcome) => void;
  let reject!: (e: unknown) => void;
  const spy = vi.fn(
    () =>
      new Promise<BranchDeleteOutcome>((res, rej) => {
        resolve = res;
        reject = rej;
      }),
  );
  return {
    spy,
    resolve: (message: string, warning: string | null = null) => resolve({ message, warning }),
    reject: (e: unknown) => reject(e),
  };
}

const statuses = () =>
  Array.from(document.querySelectorAll("[data-status]")).map((el) => el.getAttribute("data-status"));

const open = (alsoRemote: typeof target | null) =>
  useUi.setState({ deleteBranch: { branch: "feature", repoPath: "/work/repo", alsoRemote } });

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "preview_delete_branch") return localPreview;
    if (cmd === "preview_delete_remote_branch") return remotePreview;
    return undefined;
  });
  useUi.setState({ deleteBranch: null, deleteBranchRunning: false });
  useNotifications.setState({ toasts: [] });
  useRepo.setState({
    summary: { path: "/work/repo" } as never,
    // origin/feature moved since the menu opened (fetch): the lease follows it.
    branches: [{ name: "origin/feature", kind: "remote", target: "fresh-remote-oid", isHead: false, upstream: null, remote: "origin" }] as never,
    removeBranch: realRemoveBranch,
    deleteBranchAndRemote: realDeleteBranchAndRemote,
  });
});

describe("DeleteBranchDialog", () => {
  it("force-deletes the local branch, ticks the list, and closes itself", async () => {
    const run = controllable();
    useRepo.setState({ removeBranch: run.spy as never });
    open(null);
    render(<DeleteBranchDialog />);

    const button = await screen.findByRole("button", { name: "Delete branch" });
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(screen.getByText("Local branch feature points at abc1234.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(run.spy).toHaveBeenCalledWith("feature", "local-preview-oid", "/work/repo", true, expect.any(Function));
    await waitFor(() => expect(statuses()).toEqual(["active", "pending"]));

    const onDeleted = (run.spy.mock.calls[0] as unknown[])[4] as () => void;
    onDeleted();
    await waitFor(() => expect(statuses()).toEqual(["done", "active"]));

    run.resolve("Deleted feature");
    await screen.findByText("Deleted feature");
    expect(statuses()).toEqual(["done", "done"]);
    await waitFor(() => expect(useUi.getState().deleteBranch).toBeNull(), { timeout: DONE_CLOSE_MS + 1000 });
    // Routine success stays silent.
    expect(useNotifications.getState().toasts).toHaveLength(0);
  });

  it("falls back to the branch name when the delete returns no message", async () => {
    const run = controllable();
    useRepo.setState({ removeBranch: run.spy as never });
    open(null);
    render(<DeleteBranchDialog />);
    const button = await screen.findByRole("button", { name: "Delete branch" });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);

    run.resolve("");
    expect(await screen.findByText("Deleted feature")).toBeInTheDocument();
  });

  it("reports a delete warning as a notification when it closes itself", async () => {
    const run = controllable();
    useRepo.setState({ removeBranch: run.spy as never });
    open(null);
    render(<DeleteBranchDialog />);
    const button = await screen.findByRole("button", { name: "Delete branch" });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);

    const warning = "The local branch settings of feature could not be removed: locked";
    run.resolve("Deleted feature", warning);
    await waitFor(() => expect(useNotifications.getState().toasts).toHaveLength(1));
    expect(useNotifications.getState().toasts[0]).toMatchObject({ kind: "warning", title: "Deleted feature", body: warning });
    // The heading stays the plain result; the warning is shown once.
    expect(screen.getByText("Deleted feature")).toBeInTheDocument();
    await waitFor(() => expect(useUi.getState().deleteBranch).toBeNull(), { timeout: DONE_CLOSE_MS + 1000 });
  });

  it("offers the remote unticked, shows its preview when ticked, and reports a partial failure", async () => {
    const run = controllable();
    useRepo.setState({ deleteBranchAndRemote: run.spy as never });
    open(target);
    render(<DeleteBranchDialog />);

    const box = await screen.findByRole("checkbox", { name: "Also delete origin/feature on the remote" });
    expect(box).not.toBeChecked();
    expect(screen.queryByText(remotePreview.warnings[0])).not.toBeInTheDocument();

    fireEvent.click(box);
    expect(screen.getByText(remotePreview.warnings[0])).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete both" }));
    expect(run.spy).toHaveBeenCalledWith(
      "feature",
      "local-preview-oid",
      { ...target, oid: "fresh-remote-oid" },
      "/work/repo",
      expect.any(Function),
    );
    await waitFor(() => expect(statuses()).toEqual(["active", "pending", "pending"]));

    const onStep = (run.spy.mock.calls[0] as unknown[])[4] as (step: "local" | "refresh") => void;
    onStep("local");
    await waitFor(() => expect(statuses()).toEqual(["done", "active", "pending"]));

    run.reject(
      new StepOutcomeError("origin/feature was deleted, but feature was kept.", { kind: "git", message: "moved" }),
    );
    await screen.findByText("Couldn’t finish deleting feature");
    expect(statuses()).toEqual(["done", "failed", "pending"]);
    expect(screen.getByText(/origin\/feature was deleted, but feature was kept\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useUi.getState().deleteBranch).toBeNull();
  });

  it("says nothing was deleted when the remote step fails", async () => {
    const run = controllable();
    useRepo.setState({ deleteBranchAndRemote: run.spy as never });
    open(target);
    render(<DeleteBranchDialog />);

    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Delete both" }));
    run.reject(new StepOutcomeError("Nothing was deleted: origin/feature could not be deleted.", { kind: "auth", message: "denied" }));

    await screen.findByText("Nothing was deleted");
    expect(statuses()).toEqual(["failed", "pending", "pending"]);
  });

  it("withholds only the checkbox when the remote preview fails", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "preview_delete_branch") return localPreview;
      if (cmd === "preview_delete_remote_branch") throw new Error("bad remote");
      return undefined;
    });
    open(target);
    render(<DeleteBranchDialog />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Delete branch" })).not.toBeDisabled());
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("withholds the checkbox when the tracking ref is gone by preview time", async () => {
    useRepo.setState({ branches: [] });
    open(target);
    render(<DeleteBranchDialog />);

    const button = await screen.findByRole("button", { name: "Delete branch" });
    await waitFor(() => expect(button).toHaveFocus());
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("keeps Delete disabled when the local preview fails", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("gone");
    });
    open(null);
    render(<DeleteBranchDialog />);

    await screen.findByText(/Couldn’t preview the delete/);
    expect(screen.getByRole("button", { name: "Delete branch" })).toBeDisabled();
  });

  it("toasts a failure that lands after the dialog was closed", async () => {
    const run = controllable();
    useRepo.setState({ removeBranch: run.spy as never });
    open(null);
    render(<DeleteBranchDialog />);
    const button = await screen.findByRole("button", { name: "Delete branch" });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(useUi.getState().deleteBranchRunning).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(useUi.getState().deleteBranch).toBeNull();
    run.reject(new Error("index locked"));

    await waitFor(() => expect(useNotifications.getState().toasts.slice(-1)[0]?.kind).toBe("error"));
    expect(useUi.getState().deleteBranchRunning).toBe(false);
  });
});
