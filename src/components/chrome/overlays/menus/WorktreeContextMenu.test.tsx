// WorktreeContextMenu (GL-159): open-in-new-tab (GL-110), the hand-off entry
// point (GL-74), and the Remove gating — never offered for the main worktree or
// the one backing the open tab, and locked removal is forced.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import type { WorktreeDirtyState } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { WorktreeContextMenu } from "./WorktreeContextMenu";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const realOpenWorktree = useRepo.getState().openWorktree;
const realRemoveWorktree = useRepo.getState().removeWorktree;
const realCreateBranchInWorktree = useRepo.getState().createBranchInWorktree;

const mainWt = { name: "repo", path: "/work/repo", branch: "main", head: "1111111", isMain: true, bare: false, prunable: false, locked: false };
const featWt = { name: "repo-feat", path: "/work/repo-feat", branch: "feat", head: "2222222", isMain: false, bare: false, prunable: false, locked: false };
const detachedWt = { ...featWt, name: "repo-detached", path: "/work/repo-detached", branch: null, head: "abc1234def5678900000000000000000000000ff" };

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => Promise.reject(new Error(`unexpected invoke: ${cmd}`)));
  useRepo.setState({
    summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "head", detached: false },
    changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
    worktrees: [mainWt, featWt],
    openWorktree: realOpenWorktree,
    removeWorktree: realRemoveWorktree,
    createBranchInWorktree: realCreateBranchInWorktree,
  });
  useUi.setState({ worktreeMenu: null, confirm: null, prompt: null, handoff: null });
});

const openMenuFor = (wt: { path: string; name: string; isMain: boolean }) =>
  useUi.setState({ worktreeMenu: { x: 10, y: 10, path: wt.path, name: wt.name, isMain: wt.isMain } });

const CLEAN = { modified: 0, untracked: 0, ignored: 0 };

/** Answer the GL-296 dirty probe; "fail" exercises the degraded path. */
const mockDirtyProbe = (state: WorktreeDirtyState | "fail") =>
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd !== "worktree_dirty_state") return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    return state === "fail" ? Promise.reject(new Error("probe failed")) : Promise.resolve(state);
  });

/** The confirm is raised only after the probe resolves, so every removal
 * assertion has to await it rather than read straight after the click. */
const openConfirm = async () => {
  await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
  return useUi.getState().confirm!;
};

describe("WorktreeContextMenu", () => {
  it("renders nothing until a worktree menu is open", () => {
    const { container } = render(<WorktreeContextMenu />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers open / open-in-new-tab / hand-off / copy / remove for an inactive linked worktree", () => {
    openMenuFor(featWt);
    render(<WorktreeContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Open worktree" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open in new tab" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Hand off branch to…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remove worktree" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Create branch…" })).not.toBeInTheDocument();
  });

  it("creates and checks out a branch in an inactive detached worktree", async () => {
    const createBranchInWorktree = vi.fn().mockResolvedValue("created");
    useRepo.setState({
      worktrees: [mainWt, detachedWt],
      createBranchInWorktree,
    });
    openMenuFor(detachedWt);
    render(<WorktreeContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Create branch…" }));
    const prompt = useUi.getState().prompt;
    expect(prompt?.title).toBe("Create branch in repo-detached");
    expect(prompt?.message).toContain("abc1234");
    expect(prompt?.confirmLabel).toBe("Create branch");
    expect(prompt?.validate?.("bad branch")).not.toBeNull();
    prompt!.onSubmit("topic/from-detached");

    await waitFor(() =>
      expect(createBranchInWorktree).toHaveBeenCalledWith(
        "/work/repo-detached",
        "topic/from-detached",
        detachedWt.head,
      ),
    );
  });

  it("does not offer branch creation for an unusable detached worktree", () => {
    useRepo.setState({ worktrees: [mainWt, { ...detachedWt, prunable: true }] });
    openMenuFor(detachedWt);
    render(<WorktreeContextMenu />);
    expect(screen.queryByRole("menuitem", { name: "Create branch…" })).not.toBeInTheDocument();
  });

  it("open-in-new-tab passes the deliberate side-by-side flag (GL-110)", () => {
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ openWorktree });
    openMenuFor(featWt);
    render(<WorktreeContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in new tab" }));
    expect(openWorktree).toHaveBeenCalledWith("/work/repo-feat", { newTab: true });
    expect(useUi.getState().worktreeMenu).toBeNull();
  });

  it("hand-off opens the dialog for the worktree's branch (GL-74)", () => {
    openMenuFor(featWt);
    render(<WorktreeContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Hand off branch to…" }));
    expect(useUi.getState().handoff).toMatchObject({ branch: "feat", sourcePath: "/work/repo-feat" });
  });

  it("hides hand-off when no valid destination exists", () => {
    // The only other worktree is prunable (directory gone) → not a usable
    // checkout target, so the hand-off row must not be a dead click.
    useRepo.setState({ worktrees: [featWt, { ...mainWt, isMain: false, prunable: true }] });
    openMenuFor(featWt);
    render(<WorktreeContextMenu />);
    expect(screen.queryByRole("menuitem", { name: "Hand off branch to…" })).not.toBeInTheDocument();
  });

  it("the active worktree keeps copy + hand-off but hides open and remove", () => {
    openMenuFor({ path: "/work/repo", name: "repo", isMain: false });
    render(<WorktreeContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
    // Handing the *active* worktree's branch off to another workspace is a
    // legitimate flow (GL-74) — it stays even though open/remove make no sense.
    expect(screen.getByRole("menuitem", { name: "Hand off branch to…" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Open worktree" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Open in new tab" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remove worktree" })).not.toBeInTheDocument();
  });

  it("never offers Remove for the main worktree", () => {
    useRepo.setState({
      // The app is open on the linked worktree; the main one is inactive.
      summary: { path: "/work/repo-feat", workdir: "/work/repo-feat", headBranch: "feat", headOid: "head", detached: false },
    });
    openMenuFor(mainWt);
    render(<WorktreeContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Open worktree" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remove worktree" })).not.toBeInTheDocument();
  });

  it("removal of a locked worktree confirms with the lock override and forces it", async () => {
    const removeWorktree = vi.fn().mockResolvedValue("ok");
    mockDirtyProbe(CLEAN);
    useRepo.setState({
      worktrees: [mainWt, { ...featWt, locked: true }],
      removeWorktree,
    });
    openMenuFor(featWt);
    render(<WorktreeContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }));
    const confirm = await openConfirm();
    expect(confirm.warnings?.join(" ")).toContain("locked");
    expect(confirm.danger).toBe(true);
    expect(removeWorktree).not.toHaveBeenCalled();
    confirm.onConfirm();
    expect(removeWorktree).toHaveBeenCalledWith("/work/repo-feat", true);
  });

  it("removal of a clean worktree stays unforced", async () => {
    const removeWorktree = vi.fn().mockResolvedValue("ok");
    mockDirtyProbe(CLEAN);
    useRepo.setState({ removeWorktree });
    openMenuFor(featWt);
    render(<WorktreeContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }));
    const confirm = await openConfirm();
    expect(confirm.danger).toBe(true);
    expect(confirm.details?.join(" ")).toContain("/work/repo-feat");
    expect(confirm.warnings ?? []).toHaveLength(0);
    expect(confirm.confirmLabel).toBe("Remove worktree");
    confirm.onConfirm();
    expect(removeWorktree).toHaveBeenCalledWith("/work/repo-feat", false);
  });

  it("removal confirm says the branch keeps the commits for a branch-holding worktree", async () => {
    mockDirtyProbe(CLEAN);
    openMenuFor(featWt);
    render(<WorktreeContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }));
    const confirm = await openConfirm();
    expect(confirm.details?.join(" ")).toContain("Its branch feat and that branch's commits are kept.");
  });

  it("removal confirm warns a detached worktree's commit may become unreachable", async () => {
    // No branch keeps the commit once the worktree's HEAD is gone — the copy
    // must not promise "branch and commits are kept", and names the short oid.
    mockDirtyProbe(CLEAN);
    useRepo.setState({
      worktrees: [
        mainWt,
        { ...featWt, branch: null, head: "abc1234def5678900000000000000000000000ff" },
      ],
    });
    openMenuFor(featWt);
    render(<WorktreeContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }));
    const confirm = await openConfirm();
    const warnings = confirm.warnings?.join(" ") ?? "";
    expect(warnings).toContain("detached");
    expect(warnings).toContain("abc1234");
    expect(warnings).toContain("may become unreachable");
    expect(confirm.details?.join(" ")).not.toContain("kept");
  });

  // GL-296: the dirty case used to dead-end on git's `fatal: ... use --force`
  // toast. The confirm now names the loss up front and carries the force.
  it("removal of a dirty worktree quotes the work at risk and forces the remove", async () => {
    const removeWorktree = vi.fn().mockResolvedValue("ok");
    mockDirtyProbe({ modified: 29, untracked: 3, ignored: 0 });
    useRepo.setState({ removeWorktree });
    openMenuFor(featWt);
    render(<WorktreeContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }));
    const confirm = await openConfirm();
    const warnings = confirm.warnings?.join(" ") ?? "";
    expect(warnings).toContain("29 modified files and 3 untracked files");
    expect(warnings).toContain("cannot be recovered");
    // The destruction must be named in the button, not ride along on a generic
    // "Remove worktree".
    expect(confirm.confirmLabel).toBe("Remove and discard changes");
    confirm.onConfirm();
    expect(removeWorktree).toHaveBeenCalledWith("/work/repo-feat", true);
  });

  it("singularises the counts and omits the half that is zero", async () => {
    mockDirtyProbe({ modified: 1, untracked: 0, ignored: 0 });
    openMenuFor(featWt);
    render(<WorktreeContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }));
    const confirm = await openConfirm();
    const warnings = confirm.warnings?.join(" ") ?? "";
    expect(warnings).toContain("1 modified file ");
    expect(warnings).not.toContain("untracked");
  });

  // Review finding (medium): the probe is async and `confirm` is a single slot,
  // so a stale result must never open a dialog whose removal then runs against
  // a different repo.
  it("discards a probe that resolves after the repo has changed", async () => {
    const removeWorktree = vi.fn().mockResolvedValue("ok");
    let release: (v: unknown) => void = () => {};
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "worktree_dirty_state"
        ? new Promise((resolve) => (release = resolve))
        : Promise.reject(new Error(`unexpected invoke: ${cmd}`)),
    );
    useRepo.setState({ removeWorktree });
    openMenuFor(featWt);
    render(<WorktreeContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }));

    // The user switches repos while the probe is still in flight.
    useRepo.setState({
      summary: { path: "/work/other", workdir: "/work/other", headBranch: "main", headOid: "head", detached: false },
    });
    release(CLEAN);
    await Promise.resolve();
    await Promise.resolve();

    expect(useUi.getState().confirm).toBeNull();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("closes the menu before probing, so a slow probe cannot resurrect it", async () => {
    mockDirtyProbe(CLEAN);
    openMenuFor(featWt);
    render(<WorktreeContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }));
    // Closing on click also makes a double-click double-probe impossible.
    expect(useUi.getState().worktreeMenu).toBeNull();
    await openConfirm();
  });

  // A probe failure must not block the removal — it degrades to the ordinary
  // unforced confirm and lets git's own error surface.
  it("falls back to an unforced confirm when the dirty probe fails", async () => {
    const removeWorktree = vi.fn().mockResolvedValue("ok");
    mockDirtyProbe("fail");
    useRepo.setState({ removeWorktree });
    openMenuFor(featWt);
    render(<WorktreeContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }));
    const confirm = await openConfirm();
    expect(confirm.confirmLabel).toBe("Remove worktree");
    confirm.onConfirm();
    expect(removeWorktree).toHaveBeenCalledWith("/work/repo-feat", false);
  });
});
