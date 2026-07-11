import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { BranchRow, StashRow, WorktreeRow } from "./rows";

// Row contract tests (GL-192): each navigator row owns a distinct
// navigation/menu/keyboard contract — locked here against the monolithic
// rows.tsx before the per-row split, and kept green after it.

const realRevealCommit = useRepo.getState().revealCommit;
const realOpenWorktree = useRepo.getState().openWorktree;
const realRevealStash = useRepo.getState().revealStash;

beforeEach(() => {
  useRepo.setState({
    revealCommit: realRevealCommit,
    openWorktree: realOpenWorktree,
    revealStash: realRevealStash,
  });
  useUi.setState({
    navOpen: true,
    contextMenu: null,
    tagMenu: null,
    worktreeMenu: null,
    stashMenu: null,
    draggingFrom: null,
  });
});

const dataTransfer = () => ({ setData: vi.fn(), effectAllowed: "" });

describe("BranchRow", () => {
  it("navigates to the ref tip on click and closes the navigator", () => {
    const revealCommit = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ revealCommit });

    render(<BranchRow name="feature" kind="local" oid="abc123" />);
    fireEvent.click(screen.getByText("feature"));

    expect(revealCommit).toHaveBeenCalledWith("abc123");
    expect(useUi.getState().navOpen).toBe(false);
  });

  it("opens the branch context menu on right-click", () => {
    render(<BranchRow name="feature" kind="local" oid="abc123" />);
    fireEvent.contextMenu(screen.getByText("feature"));

    expect(useUi.getState().contextMenu).toMatchObject({ branch: "feature", isCurrent: false });
    expect(useUi.getState().tagMenu).toBeNull();
  });

  it("routes a tag row's right-click to the tag menu, keyed on the tagged oid", () => {
    render(<BranchRow name="v1.0" kind="tag" oid="tag123" />);
    fireEvent.contextMenu(screen.getByText("v1.0"));

    expect(useUi.getState().tagMenu).toMatchObject({ name: "v1.0", sha: "tag123" });
    expect(useUi.getState().contextMenu).toBeNull();
  });

  it("ignores a tag right-click when the oid is unknown", () => {
    render(<BranchRow name="v1.0" kind="tag" />);
    fireEvent.contextMenu(screen.getByText("v1.0"));
    expect(useUi.getState().tagMenu).toBeNull();
    expect(useUi.getState().contextMenu).toBeNull();
  });

  it("drags a local branch as a local ref; tags are not drag sources", () => {
    render(<BranchRow name="feature" kind="local" oid="abc123" />);
    fireEvent.dragStart(screen.getByText("feature"), { dataTransfer: dataTransfer() });
    expect(useUi.getState().draggingFrom).toEqual({ name: "feature", kind: "local" });

    useUi.setState({ draggingFrom: null });
    render(<BranchRow name="v1.0" kind="tag" oid="tag123" />);
    fireEvent.dragStart(screen.getByText("v1.0"), { dataTransfer: dataTransfer() });
    expect(useUi.getState().draggingFrom).toBeNull();
  });

  it("shows the sync badge for a local branch and the worktree glyph when parked elsewhere", () => {
    render(
      <BranchRow
        name="feature"
        kind="local"
        oid="abc123"
        sync={{ status: "ahead", upstream: "origin/feature", ahead: 2, behind: 0 }}
        worktree="repo-feature"
      />,
    );
    expect(screen.getByText("↑2")).toBeInTheDocument();
    expect(screen.getByLabelText("Checked out in worktree repo-feature")).toBeInTheDocument();
  });
});

describe("WorktreeRow", () => {
  const wt = { name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false };
  const props = { wt, oid: "abc123", isActive: false, label: "feature" };

  it("switches to the worktree on click (in place) and closes the navigator", () => {
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ openWorktree });

    render(<WorktreeRow {...props} />);
    fireEvent.click(screen.getByText("feature"));

    expect(openWorktree).toHaveBeenCalledWith("/work/repo-feature", { newTab: false });
    expect(useUi.getState().navOpen).toBe(false);
  });

  it("opens the worktree in a new tab on cmd/ctrl-click and keyboard Enter+meta", () => {
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ openWorktree });

    render(<WorktreeRow {...props} />);
    fireEvent.click(screen.getByText("feature"), { metaKey: true });
    expect(openWorktree).toHaveBeenLastCalledWith("/work/repo-feature", { newTab: true });

    fireEvent.keyDown(screen.getByRole("button", { name: "Open worktree feature" }), {
      key: "Enter",
      ctrlKey: true,
    });
    expect(openWorktree).toHaveBeenLastCalledWith("/work/repo-feature", { newTab: true });
  });

  it("activates from the keyboard with Enter and Space", () => {
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ openWorktree });

    render(<WorktreeRow {...props} />);
    const row = screen.getByRole("button", { name: "Open worktree feature" });

    fireEvent.keyDown(row, { key: "Enter" });
    expect(openWorktree).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(row, { key: " " });
    expect(openWorktree).toHaveBeenCalledTimes(2);
  });

  it("only reveals the tip for the already-open worktree instead of switching", () => {
    const openWorktree = vi.fn();
    const revealCommit = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ openWorktree, revealCommit });

    render(<WorktreeRow {...props} isActive />);
    fireEvent.click(screen.getByText("feature"));

    expect(openWorktree).not.toHaveBeenCalled();
    expect(revealCommit).toHaveBeenCalledWith("abc123");
  });

  it("opens the worktree menu from the kebab WITHOUT activating the row", () => {
    const openWorktree = vi.fn();
    useRepo.setState({ openWorktree });

    render(<WorktreeRow {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Worktree actions for feature" }));

    expect(useUi.getState().worktreeMenu).toMatchObject({
      path: "/work/repo-feature",
      name: "feature",
      isMain: false,
    });
    expect(openWorktree).not.toHaveBeenCalled();
    // The kebab's menu does not close the navigator; only activation does.
    expect(useUi.getState().navOpen).toBe(true);
  });

  it("stops kebab keyboard events from activating the row", () => {
    const openWorktree = vi.fn();
    useRepo.setState({ openWorktree });

    render(<WorktreeRow {...props} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Worktree actions for feature" }), {
      key: "Enter",
    });
    expect(openWorktree).not.toHaveBeenCalled();
  });

  it("opens the same worktree menu on right-click", () => {
    render(<WorktreeRow {...props} />);
    fireEvent.contextMenu(screen.getByText("feature"));
    expect(useUi.getState().worktreeMenu).toMatchObject({ path: "/work/repo-feature" });
  });
});

describe("StashRow", () => {
  const stash = {
    index: 0,
    message: "WIP on feature",
    oid: "stash123",
    timestamp: 1,
    baseOid: "base123",
    baseTimestamp: 1,
    context: [],
  };

  it("reveals the stash's graph row on click and closes the navigator", () => {
    const revealStash = vi.fn();
    useRepo.setState({ revealStash });

    render(<StashRow stash={stash} />);
    fireEvent.click(screen.getByText("WIP on feature"));

    expect(revealStash).toHaveBeenCalledWith("stash123");
    expect(useUi.getState().navOpen).toBe(false);
  });

  it("opens the stash menu on right-click, keeping the navigator open", () => {
    render(<StashRow stash={stash} />);
    fireEvent.contextMenu(screen.getByText("WIP on feature"));

    expect(useUi.getState().stashMenu).toMatchObject({ oid: "stash123", message: "WIP on feature" });
    expect(useUi.getState().navOpen).toBe(true);
  });

  it("shows the stash index as the trailing mono badge", () => {
    render(<StashRow stash={stash} />);
    expect(screen.getByText("{0}")).toBeInTheDocument();
  });
});
