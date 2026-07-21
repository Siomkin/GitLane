import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RepoSummary, WorktreeDirtyState, WorktreeInfo } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { beginPublishedRepoSession } from "@/store/repoRequests";
import { useUi } from "@/store/ui";
import { useNotifications } from "@/store/notifications";
import { RemoveDetachedDialog } from "./RemoveDetachedDialog";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

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

/** GL-297: the dialog probes every candidate before it will remove anything, so
 * the confirm button only appears once those have settled. */
const clickRemove = async () => {
  const button = await screen.findByRole("button", { name: /^Remove \d/ });
  fireEvent.click(button);
};

/** Answer the dirty probe. Defaults to clean so only the tests that care about
 * withheld candidates opt into dirtiness. */
const mockDirtyProbe = (byPath: Record<string, WorktreeDirtyState | "fail"> = {}) =>
  invokeMock.mockImplementation((cmd: string, args: { worktreePath: string }) => {
    if (cmd !== "worktree_dirty_state") return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    const state = byPath[args.worktreePath] ?? { modified: 0, untracked: 0, ignored: 0 };
    return state === "fail"
      ? Promise.reject(new Error("probe failed"))
      : Promise.resolve(state);
  });

beforeEach(() => {
  invokeMock.mockReset();
  mockDirtyProbe();
  useUi.setState({ removeDetached: null, removeDetachedRunning: false });
  useNotifications.setState({ toasts: [] });
  useRepo.setState({ removeWorktree: vi.fn().mockResolvedValue("Removed") });
});

describe("RemoveDetachedDialog", () => {
  it("renders nothing when no sweep is pending", () => {
    const { container } = render(<RemoveDetachedDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("previews every target path and removes nothing before the user confirms", async () => {
    const removeWorktree = vi.fn().mockResolvedValue("Removed");
    useRepo.setState({ removeWorktree });
    open([a, b]);
    render(<RemoveDetachedDialog />);

    expect(await screen.findByText("Remove 2 detached worktrees")).toBeInTheDocument();
    expect(screen.getByText("/work/a")).toBeInTheDocument();
    expect(screen.getByText("/work/b")).toBeInTheDocument();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("removes each target in order, never forcing, then shows the summary", async () => {
    const removeWorktree = vi.fn().mockResolvedValue("Removed");
    useRepo.setState({ removeWorktree });
    open([a, b]);
    render(<RemoveDetachedDialog />);

    await clickRemove();

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

    await clickRemove();

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

    await clickRemove();
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

  it("stops the sweep when the same repo path is reopened mid-run", async () => {
    let resolveFirst!: (msg: string) => void;
    const removeWorktree = vi
      .fn()
      .mockImplementationOnce(() => new Promise<string>((res) => { resolveFirst = res; }))
      .mockResolvedValue("Removed");
    useRepo.setState({ summary: summary("/repo"), removeWorktree });
    open([a, b]);
    render(<RemoveDetachedDialog />);

    await clickRemove();
    await waitFor(() => expect(removeWorktree).toHaveBeenCalledTimes(1));
    act(() => {
      beginPublishedRepoSession();
      useRepo.setState({ summary: summary("/other") });
      beginPublishedRepoSession();
      useRepo.setState({ summary: summary("/repo") });
    });
    resolveFirst("Removed");

    await waitFor(() =>
      expect(screen.getByText(/Removed 1 of 2 detached worktrees — Repository changed/)).toBeInTheDocument(),
    );
    expect(removeWorktree).toHaveBeenCalledTimes(1);
  });

  it("blocks a second sweep while one is already running", async () => {
    useUi.setState({ removeDetachedRunning: true });
    open([a]);
    render(<RemoveDetachedDialog />);

    expect(await screen.findByRole("button", { name: /^Remove \d/ })).toBeDisabled();
    expect(screen.getByText(/Another sweep is still finishing/)).toBeInTheDocument();
  });

  // GL-297: "detached" is not "disposable". A candidate holding uncommitted work
  // is withheld from the sweep and listed with the reason, instead of failing
  // mid-run on git's refusal.
  it("withholds a dirty candidate and says what it is keeping", async () => {
    const removeWorktree = vi.fn().mockResolvedValue("Removed");
    useRepo.setState({ removeWorktree });
    mockDirtyProbe({ "/work/b": { modified: 29, untracked: 3, ignored: 0 } });
    open([a, b]);
    render(<RemoveDetachedDialog />);

    expect(await screen.findByText("Remove 1 detached worktree")).toBeInTheDocument();
    expect(screen.getByText("Kept (1)")).toBeInTheDocument();
    expect(screen.getByText("Has 29 modified files and 3 untracked files")).toBeInTheDocument();

    await clickRemove();
    await waitFor(() => expect(removeWorktree).toHaveBeenCalledTimes(1));
    expect(removeWorktree).toHaveBeenCalledWith("/work/a", false);
  });

  // An agent's worktree is detached *by construction* — it is the most live
  // worktree in the repo, not the most disposable.
  it("withholds an agent-managed worktree even when it is clean", async () => {
    const removeWorktree = vi.fn().mockResolvedValue("Removed");
    const agent = wt({ name: "GitLane", path: "/Users/me/.codex/worktrees/6d30/GitLane" });
    useRepo.setState({ removeWorktree });
    open([a, agent]);
    render(<RemoveDetachedDialog />);

    expect(await screen.findByText("Remove 1 detached worktree")).toBeInTheDocument();
    expect(screen.getByText("In use by a coding agent")).toBeInTheDocument();

    await clickRemove();
    await waitFor(() => expect(removeWorktree).toHaveBeenCalledTimes(1));
    expect(removeWorktree).toHaveBeenCalledWith("/work/a", false);
  });

  // Review finding: `|` is legal in a POSIX filename, so a delimiter-joined
  // effect key could be forged by a different target set and silently reuse its
  // probe results. The key is JSON, so these two sets stay distinct.
  it("keys probes so a path containing the delimiter cannot reuse another set's results", async () => {
    const odd = wt({ name: "odd", path: "/work/a|/work/b" });
    mockDirtyProbe({ "/work/a|/work/b": { modified: 7, untracked: 0, ignored: 0 } });
    open([odd]);
    render(<RemoveDetachedDialog />);

    expect(await screen.findByText("Nothing to remove")).toBeInTheDocument();
    expect(screen.getByText("Has 7 modified files")).toBeInTheDocument();
  });

  // Agent rows are withheld on their path alone, so spending a `git status` on
  // them would buy an answer that cannot change the outcome.
  it("does not probe an agent-managed candidate", async () => {
    const agent = wt({ name: "GitLane", path: "/Users/me/.codex/worktrees/6d30/GitLane" });
    open([a, agent]);
    render(<RemoveDetachedDialog />);

    await screen.findByText("Remove 1 detached worktree");
    const probed = invokeMock.mock.calls
      .filter(([cmd]) => cmd === "worktree_dirty_state")
      .map(([, args]) => (args as { worktreePath: string }).worktreePath);
    expect(probed).toEqual(["/work/a"]);
  });

  // The empty-state copy must not assert what the withheld rows contain: a
  // skipped candidate may be dirty, agent-owned, or merely unverifiable.
  it("does not claim skipped worktrees hold changes when they are agent-owned", async () => {
    const agent = wt({ name: "GitLane", path: "/Users/me/.codex/worktrees/6d30/GitLane" });
    open([agent]);
    render(<RemoveDetachedDialog />);

    expect(await screen.findByText("Nothing to remove")).toBeInTheDocument();
    expect(screen.getByText(/each row below says why/)).toBeInTheDocument();
    expect(screen.queryByText(/would destroy/)).not.toBeInTheDocument();
  });

  it("names the dialog by its visible state while probing", async () => {
    open([a]);
    render(<RemoveDetachedDialog />);
    // Never "Remove 0 detached worktrees" while the count is still unknown.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-label", "Checking worktrees…");
    expect(dialog).toHaveAttribute("aria-busy", "true");
    await screen.findByText("Remove 1 detached worktree");
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "Remove 1 detached worktree");
  });

  it("withholds a candidate whose probe failed rather than guessing it is clean", async () => {
    mockDirtyProbe({ "/work/a": "fail" });
    open([a]);
    render(<RemoveDetachedDialog />);

    expect(await screen.findByText("Nothing to remove")).toBeInTheDocument();
    expect(screen.getByText("Couldn’t check for uncommitted changes")).toBeInTheDocument();
    // With nothing removable there is no destructive button to press at all.
    expect(screen.queryByRole("button", { name: /^Remove \d/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("finishes in the background and toasts the summary when closed mid-run", async () => {
    let resolveRemove!: (msg: string) => void;
    const removeWorktree = vi.fn().mockImplementation(
      () => new Promise<string>((res) => { resolveRemove = res; }),
    );
    useRepo.setState({ removeWorktree });
    open([a]);
    const { rerender } = render(<RemoveDetachedDialog />);

    await clickRemove();
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
