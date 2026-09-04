import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRepo } from "@/store/repo";
import { useUi, MenuKind } from "@/store/ui";
import { useNotifications } from "@/store/notifications";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { ActionMenu } from "./menus";

// useBranchFastForwardProbe calls `api.canFastForward` (→ invoke) while a branch
// other than HEAD is selected, so the IPC boundary must be mocked. Reject
// any other command so a stray invoke fails loudly instead of silently resolving.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// Captured before any test mutates store actions, so beforeEach can restore the
// real actions after a test swaps in a spy (Zustand setState merges, so a mocked
// action would otherwise leak into later tests — and into later test files, since
// the store is a shared singleton with no global reset).
const realRemoveBranch = useRepo.getState().removeBranch;
const realCreateWorktreeAt = useRepo.getState().createWorktreeAt;
const realPublishBranch = useRepo.getState().publishBranch;
const realMoveBranchToWorktree = useRepo.getState().moveBranchToWorktree;
const realDeleteBranchWithWorktree = useRepo.getState().deleteBranchWithWorktree;
const realRemoveWorktree = useRepo.getState().removeWorktree;
const realOpenWorktree = useRepo.getState().openWorktree;
const realOpenCompare = useRepo.getState().openCompare;
const realCheckoutBranch = useRepo.getState().checkoutBranch;
const realCheckoutRemoteBranch = useRepo.getState().checkoutRemoteBranch;
const realRebaseOnto = useRepo.getState().rebaseOnto;
const realResetBranchTo = useRepo.getState().resetBranchTo;
const realMergeInto = useRepo.getState().mergeInto;
const realForcePush = useRepo.getState().forcePush;
const realRevertCommit = useRepo.getState().revertCommit;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "can_fast_forward") return Promise.resolve(false);
    // GL-296: the removal confirm probes the worktree first; default to clean
    // so only the tests that care about dirtiness opt into it.
    if (cmd === "worktree_dirty_state") return Promise.resolve({ modified: 0, untracked: 0 });
    if (cmd === "preview_remove_worktree") {
      return Promise.resolve({
        summary: "Impact summary",
        details: ["Affected path"],
        warnings: ["Recovery warning"],
        requiresForce: false,
        locked: false,
        dirty: false,
        ignoredOnly: false,
        expectedState: "worktree-removal-lease-v1",
      });
    }
    if (cmd.startsWith("preview_")) {
      return Promise.resolve({
        summary: "Impact summary",
        details: ["Affected path"],
        warnings: ["Recovery warning"],
        expectedOid: "branch-preview-oid",
        expectedState: "discard-all-state-v1",
        expectedHeadBranch: "main",
        expectedHeadOid: "head",
        targetOid: "target-preview-oid",
        expectedSourceOid: "source-preview-oid",
      });
    }
    return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
  });
  useRepo.setState({
    changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
    summary: null,
    branches: [],
    worktrees: [],
    selectedCommits: [],
    removeBranch: realRemoveBranch,
    createWorktreeAt: realCreateWorktreeAt,
    publishBranch: realPublishBranch,
    moveBranchToWorktree: realMoveBranchToWorktree,
    deleteBranchWithWorktree: realDeleteBranchWithWorktree,
    removeWorktree: realRemoveWorktree,
    openWorktree: realOpenWorktree,
    openCompare: realOpenCompare,
    checkoutBranch: realCheckoutBranch,
    checkoutRemoteBranch: realCheckoutRemoteBranch,
    rebaseOnto: realRebaseOnto,
    resetBranchTo: realResetBranchTo,
    mergeInto: realMergeInto,
    forcePush: realForcePush,
    revertCommit: realRevertCommit,
  });
  useUi.setState({
    menu: null,
    confirm: null,
    prompt: null,
    deleteWorktree: null,
    createBranchOpen: false,
    createBranchStart: null,
    aiActions: null,
  });
  useNotifications.setState({ toasts: [] });
});

const localBranch = (name: string) => ({
  name,
  kind: "local" as const,
  target: "abc1234",
  isHead: false,
  upstream: null,
  remote: null,
});

const remoteBranch = (name: string) => ({
  name,
  kind: "remote" as const,
  target: "abc1234",
  isHead: false,
  upstream: null,
  // Backend attributes each remote branch to its remote; the delete-on-remote
  // action reads this rather than splitting the name on the first `/`.
  remote: name.split("/")[0],
});

describe("ActionMenu", () => {
  const localSummary = {
    path: "/work/repo",
    workdir: "/work/repo",
    headBranch: "main",
    headOid: "head",
    detached: false,
  };

  const openActionMenu = (fromName: string, toName: string) =>
    useUi.setState({
      menu: { kind: MenuKind.Action, state: {
        x: 10,
        y: 10,
        from: { name: fromName, kind: "local" },
        to: { kind: "local", name: toName },
      } },
    });

  // Rebases always confirm the immutable source/target pair. The backend owns
  // the source checkout in the same git process, so a previously active branch
  // cannot become the accidental rebase actor between two IPC calls.
  it("rebase-source confirms the exact pair and sends both operands atomically", async () => {
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    const rebaseOnto = vi.fn().mockResolvedValue("Rebased onto main");
    useRepo.setState({
      summary: localSummary,
      branches: [localBranch("feature"), localBranch("main")],
      checkoutBranch,
      rebaseOnto,
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    // The accessible name is prefixed by the icon glyph and suffixed by the
    // `sub` line, so match the label substring rather than anchoring.
    fireEvent.click(screen.getByRole("menuitem", { name: /Rebase feature onto main/ }));

    // Nothing ran yet — the confirm names the branch, prerequisite, and target.
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    expect(confirm!.title).toBe("Rebase feature onto main?");
    expect(confirm!.message).toContain('Check out branch "feature"');
    expect(confirm!.message).toContain('onto "main"');
    expect(confirm!.confirmLabel).toBe("Check out feature and rebase");
    expect(checkoutBranch).not.toHaveBeenCalled();
    expect(rebaseOnto).not.toHaveBeenCalled();

    confirm!.onConfirm();
    await waitFor(() => expect(rebaseOnto).toHaveBeenCalledWith("feature", "main"));
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("cancelling the rebase confirmation performs neither checkout nor rebase", () => {
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    const rebaseOnto = vi.fn().mockResolvedValue("Rebased onto main");
    useRepo.setState({
      summary: localSummary,
      branches: [localBranch("feature"), localBranch("main")],
      checkoutBranch,
      rebaseOnto,
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: /Rebase feature onto main/ }));
    expect(useUi.getState().confirm).not.toBeNull();

    // The dialog cancels by clearing the pending confirm without running it.
    useUi.getState().closeConfirm();
    expect(useUi.getState().confirm).toBeNull();
    expect(checkoutBranch).not.toHaveBeenCalled();
    expect(rebaseOnto).not.toHaveBeenCalled();
  });

  it("still confirms the exact pair when the rebased branch is already checked out", async () => {
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    const rebaseOnto = vi.fn().mockResolvedValue("Rebased onto main");
    useRepo.setState({
      // feature is HEAD → no branch switch is needed, but rebase still confirms.
      summary: { ...localSummary, headBranch: "feature" },
      branches: [localBranch("feature"), localBranch("main")],
      checkoutBranch,
      rebaseOnto,
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: /Rebase feature onto main/ }));
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    expect(confirm!.title).toBe("Rebase feature onto main?");
    expect(confirm!.confirmLabel).toBe("Rebase");
    confirm!.onConfirm();
    await waitFor(() => expect(rebaseOnto).toHaveBeenCalledWith("feature", "main"));
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("merge-target asks to approve the implicit checkout of the drop target", async () => {
    const mergeInto = vi.fn().mockResolvedValue("Merged feature into main");
    useRepo.setState({
      // HEAD is elsewhere, so merging into main first checks main out.
      summary: { ...localSummary, headBranch: "feature" },
      branches: [localBranch("feature"), localBranch("main")],
      mergeInto,
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: /Merge feature into main/ }));
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    expect(confirm!.title).toBe("Check out main?");
    expect(confirm!.confirmLabel).toBe("Check out and merge");
    expect(mergeInto).not.toHaveBeenCalled();

    confirm!.onConfirm();
    await waitFor(() => expect(mergeInto).toHaveBeenCalledWith("feature", "main"));
  });

  it("merges without a popup when the drop target is already checked out", async () => {
    const mergeInto = vi.fn().mockResolvedValue("Merged feature into main");
    useRepo.setState({
      summary: localSummary, // headBranch: "main" — the merge target
      branches: [localBranch("feature"), localBranch("main")],
      mergeInto,
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: /Merge feature into main/ }));
    expect(useUi.getState().confirm).toBeNull();
    await waitFor(() => expect(mergeInto).toHaveBeenCalledWith("feature", "main"));
  });

  it("dragging a local branch onto a local branch never offers the reverse direction", () => {
    useRepo.setState({
      summary: localSummary,
      branches: [localBranch("feature"), localBranch("main")],
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    // feature is the actor; main (the target) is never the one rebased/reset.
    expect(screen.getByRole("menuitem", { name: /Rebase feature onto main/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Reset feature to main/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Rebase main onto feature/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Reset main to feature/ })).not.toBeInTheDocument();
  });

  it("never offers the target-moving fast-forward on a local drag, even when it's possible", async () => {
    // The target (main) *could* fast-forward to the dragged branch (feature),
    // but on a local drag only the dragged branch moves — so the reverse FF must
    // not appear, and the wasted probe for it isn't even issued.
    invokeMock.mockImplementation((cmd: string, args: { from: string; to: string }) => {
      if (cmd === "can_fast_forward") {
        // Reverse direction (advance main to feature) would be offered if read.
        if (args.from === "feature" && args.to === "main") return Promise.resolve(true);
        return Promise.resolve(false);
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    useRepo.setState({
      summary: localSummary,
      branches: [localBranch("feature"), localBranch("main")],
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: /Rebase feature onto main/ })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("menuitem", { name: /Fast-forward main to feature/ })).not.toBeInTheDocument();
    // The reverse-direction probe (from=feature,to=main) is never issued.
    expect(invokeMock).not.toHaveBeenCalledWith(
      "can_fast_forward",
      expect.objectContaining({ from: "feature", to: "main" }),
    );
  });

  it("reset-source previews then resets the dragged branch to the drop target on confirm", async () => {
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    const resetBranchTo = vi.fn().mockResolvedValue("Reset feature to main");
    useRepo.setState({
      summary: localSummary,
      branches: [localBranch("feature"), localBranch("main")],
      checkoutBranch,
      resetBranchTo,
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: /Reset feature to main/ }));

    // Preview is anchored on the branch being reset (feature), not HEAD.
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
    expect(invokeMock).toHaveBeenCalledWith(
      "preview_reset",
      expect.objectContaining({ target: "main", mode: "mixed", source: "feature" }),
    );
    // HEAD is main, so the single dialog also covers the checkout prerequisite
    // (GL-217) — no second popup stacks on top of the preview confirm.
    expect(useUi.getState().confirm!.message).toContain('Check out branch "feature"');
    expect(useUi.getState().confirm!.confirmLabel).toBe("Check out feature and reset (mixed)");

    useUi.getState().confirm!.onConfirm();
    await waitFor(() =>
      expect(resetBranchTo).toHaveBeenCalledWith(
        "feature",
        "main",
        "mixed",
        expect.objectContaining({ targetOid: "target-preview-oid" }),
      ),
    );
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("rebases a remote feature's local counterpart onto the drop target, not the target onto the remote", async () => {
    const checkoutRemoteBranch = vi.fn().mockResolvedValue("Checked out feature");
    const rebaseOnto = vi.fn().mockResolvedValue("Rebased feature onto main");
    useRepo.setState({
      summary: localSummary,
      branches: [remoteBranch("origin/feature"), localBranch("main"), localBranch("feature")],
      checkoutRemoteBranch,
      rebaseOnto,
    });
    useUi.setState({
      menu: { kind: MenuKind.Action, state: {
        x: 10,
        y: 10,
        from: { name: "origin/feature", kind: "remote" },
        to: { kind: "local", name: "main" },
      } },
    });
    render(<ActionMenu />);

    expect(screen.queryByRole("menuitem", { name: /Rebase origin\/feature onto main/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Rebase main onto origin\/feature/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Reset origin\/feature to main/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: /Rebase feature onto main/ }));
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    expect(confirm!.title).toBe("Rebase feature onto main?");
    expect(confirm!.confirmLabel).toBe("Check out feature and rebase");
    confirm!.onConfirm();
    await waitFor(() => expect(rebaseOnto).toHaveBeenCalledWith("feature", "main"));
    expect(checkoutRemoteBranch).not.toHaveBeenCalled();
  });

  it("creates the local counterpart before rebasing when it is missing", async () => {
    const checkoutRemoteBranch = vi.fn().mockResolvedValue("Checked out feature");
    const rebaseOnto = vi.fn().mockResolvedValue("Rebased feature onto main");
    useRepo.setState({
      summary: localSummary,
      branches: [remoteBranch("origin/feature"), localBranch("main")],
      checkoutRemoteBranch,
      rebaseOnto,
    });
    useUi.setState({
      menu: { kind: MenuKind.Action, state: {
        x: 10,
        y: 10,
        from: { name: "origin/feature", kind: "remote" },
        to: { kind: "local", name: "main" },
      } },
    });
    render(<ActionMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: /Rebase feature onto main/ }));
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    expect(confirm!.title).toBe("Rebase feature onto main?");
    expect(confirm!.message).toContain('Check out branch "feature"');
    confirm!.onConfirm();
    await waitFor(() => expect(checkoutRemoteBranch).toHaveBeenCalledWith("origin", "feature"));
    await waitFor(() => expect(rebaseOnto).toHaveBeenCalledWith("feature", "main"));
  });

  it("cancelling a remote-feature rebase performs neither checkout nor rebase", () => {
    const checkoutRemoteBranch = vi.fn().mockResolvedValue("Checked out feature");
    const rebaseOnto = vi.fn().mockResolvedValue("Rebased feature onto main");
    useRepo.setState({
      summary: localSummary,
      branches: [remoteBranch("origin/feature"), localBranch("main")],
      checkoutRemoteBranch,
      rebaseOnto,
    });
    useUi.setState({
      menu: { kind: MenuKind.Action, state: {
        x: 10,
        y: 10,
        from: { name: "origin/feature", kind: "remote" },
        to: { kind: "local", name: "main" },
      } },
    });
    render(<ActionMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: /Rebase feature onto main/ }));
    expect(useUi.getState().confirm).not.toBeNull();
    useUi.getState().closeOverlays();
    expect(checkoutRemoteBranch).not.toHaveBeenCalled();
    expect(rebaseOnto).not.toHaveBeenCalled();
  });

  it("asks to check out the counterpart when HEAD is on the drop target", async () => {
    const rebaseOnto = vi.fn().mockResolvedValue("Rebased feature onto main");
    useRepo.setState({
      summary: localSummary, // headBranch: main
      branches: [remoteBranch("origin/feature"), localBranch("main"), localBranch("feature")],
      rebaseOnto,
    });
    useUi.setState({
      menu: { kind: MenuKind.Action, state: {
        x: 10,
        y: 10,
        from: { name: "origin/feature", kind: "remote" },
        to: { kind: "local", name: "main" },
      } },
    });
    render(<ActionMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: /Rebase feature onto main/ }));
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    expect(confirm!.title).toBe("Rebase feature onto main?");
    expect(confirm!.confirmLabel).toBe("Check out feature and rebase");
    confirm!.onConfirm();
    await waitFor(() => expect(rebaseOnto).toHaveBeenCalledWith("feature", "main"));
  });

  it("always asks before a checkout-based op when HEAD is detached", () => {
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      // Detached HEAD: any branch checkout is a real switch, so the gate shows
      // even though headBranch may still report the last branch name.
      summary: { ...localSummary, headBranch: "feature", detached: true },
      branches: [localBranch("feature"), localBranch("main")],
      checkoutBranch,
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: /Rebase feature onto main/ }));
    expect(useUi.getState().confirm).not.toBeNull();
    expect(useUi.getState().confirm!.title).toBe("Rebase feature onto main?");
    expect(useUi.getState().confirm!.confirmLabel).toBe("Check out feature and rebase");
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  // A checkout-based op (rebase/reset of the dragged branch, or merge — all check
  // out the branch they mutate) can't run when git already has that branch out in
  // another worktree. GL-103: disable it up front instead of letting the checkout
  // fail with a raw worktree error.
  it("disables the dragged-branch ops when the dragged branch lives in another worktree", () => {
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      summary: localSummary,
      branches: [localBranch("feature"), localBranch("main")],
      worktrees: [{ name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false }],
      checkoutBranch,
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    const rebase = screen.getByRole("menuitem", { name: /Rebase feature onto main/ });
    const reset = screen.getByRole("menuitem", { name: /Reset feature to main/ });
    expect(rebase).toBeDisabled();
    expect(reset).toBeDisabled();
    expect(rebase).toHaveTextContent("feature is checked out in worktree repo-feature");

    // Clicking the disabled op does nothing — no checkout is attempted.
    fireEvent.click(rebase);
    expect(checkoutBranch).not.toHaveBeenCalled();

    // Merge checks out the *target* (main), which is free, so it stays enabled.
    expect(screen.getByRole("menuitem", { name: /Merge feature into main/ })).toBeEnabled();
  });

  it("disables Merge when the drop-target branch lives in another worktree", () => {
    useRepo.setState({
      summary: localSummary,
      branches: [localBranch("feature"), localBranch("main")],
      worktrees: [{ name: "repo-main", path: "/work/repo-main", branch: "main", isMain: false }],
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    const merge = screen.getByRole("menuitem", { name: /Merge feature into main/ });
    expect(merge).toBeDisabled();
    expect(merge).toHaveTextContent("main is checked out in worktree repo-main");

    // Rebasing/resetting the dragged branch checks out feature (free) — enabled.
    expect(screen.getByRole("menuitem", { name: /Rebase feature onto main/ })).toBeEnabled();
  });

  it("keeps fast-forward enabled when the dragged branch lives in another worktree", async () => {
    // Fast-forward updates the branch in its owning worktree, so it stays
    // clickable when the branch is held elsewhere — unlike rebase/reset.
    invokeMock.mockImplementation((cmd: string, args: { from: string; to: string }) => {
      if (cmd === "can_fast_forward") {
        // Advancing feature to main (sourceToTarget) is possible → FF is offered.
        return Promise.resolve(args.from === "2222222" && args.to === "1111111");
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    useRepo.setState({
      summary: localSummary,
      branches: [
        { ...localBranch("feature"), target: "1111111" },
        { ...localBranch("main"), target: "2222222" },
      ],
      worktrees: [{ name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false }],
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    const ff = await screen.findByRole("menuitem", { name: /Fast-forward feature to main/ });
    expect(ff).toBeEnabled();
    // The checkout-based ops for the same held branch are still disabled.
    expect(screen.getByRole("menuitem", { name: /Rebase feature onto main/ })).toBeDisabled();
  });

  it("guards rebase/reset of the dragged branch when dropped on a commit", () => {
    useRepo.setState({
      summary: localSummary,
      branches: [localBranch("feature")],
      worktrees: [{ name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false }],
    });
    useUi.setState({
      menu: { kind: MenuKind.Action, state: {
        x: 10,
        y: 10,
        from: { name: "feature", kind: "local" },
        to: { kind: "commit", sha: "deadbeefcafe", shortSha: "deadbee" },
      } },
    });
    render(<ActionMenu />);

    // Dropping the held branch on a commit still checks it out to rebase/reset.
    expect(screen.getByRole("menuitem", { name: /Rebase feature onto deadbee/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /Reset feature to deadbee/ })).toBeDisabled();
  });

  it("disables the target-moving ops when a remote source is dropped on a target held elsewhere", () => {
    useRepo.setState({
      summary: localSummary,
      branches: [remoteBranch("origin/feature"), localBranch("main")],
      worktrees: [{ name: "repo-main", path: "/work/repo-main", branch: "main", isMain: false }],
    });
    useUi.setState({
      menu: { kind: MenuKind.Action, state: {
        x: 10,
        y: 10,
        from: { name: "origin/feature", kind: "remote" },
        to: { kind: "local", name: "main" },
      } },
    });
    render(<ActionMenu />);

    // Merge and reset still check out main → disabled. Rebase now moves
    // feature onto main, and feature is free in this worktree.
    expect(screen.getByRole("menuitem", { name: /Merge origin\/feature into main/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /Rebase feature onto main/ })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /Reset main to origin\/feature/ })).toBeDisabled();
  });

  it("disables rebase of a remote feature when its local counterpart is held elsewhere", () => {
    useRepo.setState({
      summary: localSummary,
      branches: [remoteBranch("origin/feature"), localBranch("main"), localBranch("feature")],
      worktrees: [{ name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false }],
    });
    useUi.setState({
      menu: { kind: MenuKind.Action, state: {
        x: 10,
        y: 10,
        from: { name: "origin/feature", kind: "remote" },
        to: { kind: "local", name: "main" },
      } },
    });
    render(<ActionMenu />);

    const rebase = screen.getByRole("menuitem", { name: /Rebase feature onto main/ });
    expect(rebase).toBeDisabled();
    expect(rebase).toHaveTextContent("feature is checked out in worktree repo-feature");
  });
});
