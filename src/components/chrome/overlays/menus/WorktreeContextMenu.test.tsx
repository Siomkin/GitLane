// WorktreeContextMenu (GL-159): open-in-new-tab (GL-110), the hand-off entry
// point (GL-74), and the Remove gating — never offered for the main worktree or
// the one backing the open tab, and locked removal is forced.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { emptyAdvancedState } from "../../../../lib/advancedRepoState";
import { useRepo } from "../../../../store/repo";
import { useUi } from "../../../../store/ui";
import { WorktreeContextMenu } from "./WorktreeContextMenu";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const realOpenWorktree = useRepo.getState().openWorktree;
const realRemoveWorktree = useRepo.getState().removeWorktree;

const mainWt = { name: "repo", path: "/work/repo", branch: "main", isMain: true, bare: false, prunable: false, locked: false };
const featWt = { name: "repo-feat", path: "/work/repo-feat", branch: "feat", isMain: false, bare: false, prunable: false, locked: false };

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => Promise.reject(new Error(`unexpected invoke: ${cmd}`)));
  useRepo.setState({
    summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "head", detached: false },
    changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
    worktrees: [mainWt, featWt],
    openWorktree: realOpenWorktree,
    removeWorktree: realRemoveWorktree,
  });
  useUi.setState({ worktreeMenu: null, confirm: null, handoff: null });
});

const openMenuFor = (wt: { path: string; name: string; isMain: boolean }) =>
  useUi.setState({ worktreeMenu: { x: 10, y: 10, path: wt.path, name: wt.name, isMain: wt.isMain } });

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

  it("removal of a locked worktree confirms with the lock override and forces it", () => {
    const removeWorktree = vi.fn().mockResolvedValue("ok");
    useRepo.setState({
      worktrees: [mainWt, { ...featWt, locked: true }],
      removeWorktree,
    });
    openMenuFor(featWt);
    render(<WorktreeContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }));
    const confirm = useUi.getState().confirm;
    expect(confirm?.message).toContain("locked");
    expect(confirm?.danger).toBe(true);
    expect(removeWorktree).not.toHaveBeenCalled();
    confirm!.onConfirm();
    expect(removeWorktree).toHaveBeenCalledWith("/work/repo-feat", true);
  });

  it("removal of an ordinary worktree stays unforced so git's dirty check applies", () => {
    const removeWorktree = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ removeWorktree });
    openMenuFor(featWt);
    render(<WorktreeContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }));
    const confirm = useUi.getState().confirm;
    expect(confirm?.danger).toBe(true);
    expect(confirm?.message).toContain("/work/repo-feat");
    expect(confirm?.message).not.toContain("locked");
    confirm!.onConfirm();
    expect(removeWorktree).toHaveBeenCalledWith("/work/repo-feat", false);
  });
});
