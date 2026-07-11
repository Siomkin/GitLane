import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitNode } from "../../lib/api";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { CommitRow } from "./commit-row";

const commit = (over: Partial<CommitNode> = {}): CommitNode => ({
  id: "c1",
  shortId: "c1",
  summary: "a commit",
  body: "",
  authorName: "Ada",
  authorEmail: "ada@example.test",
  timestamp: 1,
  parents: [],
  lane: 0,
  row: 0,
  color: 0,
  refs: [],
  ...over,
});

const baseProps = {
  currentBranch: "main",
  selected: false,
  focused: false,
  flash: false,
  dimmed: false,
  query: "",
  top: 0,
  rowHeight: 40,
  graphColW: 80,
  onSelect: () => {},
};

const realCheckoutBranch = useRepo.getState().checkoutBranch;
const realCheckoutRemoteBranch = useRepo.getState().checkoutRemoteBranch;

beforeEach(() => {
  useRepo.setState({
    summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
    worktrees: [],
    branches: [],
    selectedCommits: [],
    checkoutBranch: realCheckoutBranch,
    checkoutRemoteBranch: realCheckoutRemoteBranch,
  });
  useUi.setState({
    commitMenu: null,
    contextMenu: null,
    tagMenu: null,
    actionMenu: null,
    draggingFrom: null,
  });
});

// jsdom has no DataTransfer; fireEvent needs a stub for drag events.
const dataTransfer = () => ({ setData: vi.fn(), effectAllowed: "" });

describe("CommitRow ref pills", () => {
  it("marks a branch checked out in another worktree with the worktree tooltip", () => {
    useRepo.setState({
      worktrees: [{ name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false }],
    });
    render(<CommitRow {...baseProps} commit={commit({ refs: [{ name: "feature", kind: "branch" }] })} />);
    expect(screen.getByTitle("Checked out in worktree: repo-feature")).toBeInTheDocument();
  });

  it("shows no worktree marker for an ordinary branch", () => {
    render(<CommitRow {...baseProps} commit={commit({ refs: [{ name: "feature", kind: "branch" }] })} />);
    expect(screen.queryByTitle(/Checked out in worktree/)).not.toBeInTheDocument();
  });

  it("updates the worktree glyph live when the worktree binding changes", () => {
    render(<CommitRow {...baseProps} commit={commit({ refs: [{ name: "feature", kind: "branch" }] })} />);
    expect(screen.queryByTitle(/Checked out in worktree/)).not.toBeInTheDocument();

    act(() => {
      useRepo.setState({
        worktrees: [{ name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false }],
      });
    });
    expect(screen.getByTitle("Checked out in worktree: repo-feature")).toBeInTheDocument();

    act(() => {
      useRepo.setState({ worktrees: [] });
    });
    expect(screen.queryByTitle(/Checked out in worktree/)).not.toBeInTheDocument();
  });

  it("double-clicks a remote-only ref into a local tracking checkout", async () => {
    const checkoutRemoteBranch = vi.fn().mockResolvedValue("Checked out feature");
    const checkoutBranch = vi.fn().mockResolvedValue("detached");
    useRepo.setState({
      branches: [
        {
          name: "origin/feature",
          kind: "remote",
          target: "c1",
          isHead: false,
          upstream: null,
          remote: "origin",
        },
      ],
      checkoutBranch,
      checkoutRemoteBranch,
    });

    render(<CommitRow {...baseProps} commit={commit({ refs: [{ name: "origin/feature", kind: "remote" }] })} />);
    fireEvent.doubleClick(screen.getByText("origin/feature"));

    await waitFor(() => expect(checkoutRemoteBranch).toHaveBeenCalledWith("origin", "feature"));
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("opens the branch context menu from a pill without opening the commit menu", () => {
    render(<CommitRow {...baseProps} commit={commit({ refs: [{ name: "feature", kind: "branch" }] })} />);
    fireEvent.contextMenu(screen.getByText("feature"));

    expect(useUi.getState().contextMenu).toMatchObject({ branch: "feature", isCurrent: false });
    // stopPropagation keeps the row's commit menu closed.
    expect(useUi.getState().commitMenu).toBeNull();
  });

  it("opens the tag menu from a tag pill, targeting this row's commit", () => {
    render(<CommitRow {...baseProps} commit={commit({ refs: [{ name: "v1.0", kind: "tag" }] })} />);
    fireEvent.contextMenu(screen.getByText("v1.0"));

    expect(useUi.getState().tagMenu).toMatchObject({ name: "v1.0", sha: "c1" });
    expect(useUi.getState().commitMenu).toBeNull();
  });

  it("starts a local-branch drag from a branch pill with the move payload", () => {
    render(<CommitRow {...baseProps} commit={commit({ refs: [{ name: "feature", kind: "branch" }] })} />);
    const dt = dataTransfer();
    fireEvent.dragStart(screen.getByText("feature"), { dataTransfer: dt });

    expect(useUi.getState().draggingFrom).toEqual({ name: "feature", kind: "local" });
    // The drag payload is part of the contract: plain-text ref name, move cursor.
    expect(dt.setData).toHaveBeenCalledWith("text/plain", "feature");
    expect(dt.effectAllowed).toBe("move");
  });

  it("double-clicks a local branch pill straight into checkout", async () => {
    const checkoutBranch = vi.fn().mockResolvedValue("Checked out feature");
    const checkoutRemoteBranch = vi.fn();
    useRepo.setState({ checkoutBranch, checkoutRemoteBranch });

    render(<CommitRow {...baseProps} commit={commit({ refs: [{ name: "feature", kind: "branch" }] })} />);
    fireEvent.doubleClick(screen.getByText("feature"));

    await waitFor(() => expect(checkoutBranch).toHaveBeenCalledWith("feature"));
    expect(checkoutRemoteBranch).not.toHaveBeenCalled();
  });
});

describe("CommitRow grouped refs", () => {
  const groupedCommit = () =>
    commit({
      refs: [
        { name: "main", kind: "branch" },
        { name: "origin/main", kind: "remote" },
      ],
    });

  it("collapses an in-sync local + remote into one pill and splits it on click", () => {
    render(<CommitRow {...baseProps} commit={groupedCommit()} />);

    // Collapsed: one combined pill, no individual origin/main pill.
    const combined = screen.getByTitle("main — local + 1 remote in sync (click to split)");
    expect(screen.queryByText("origin/main")).not.toBeInTheDocument();

    fireEvent.click(combined);

    // Split: the individual pills plus the recombine chevron.
    expect(screen.getByText("origin/main")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Combine local + remote"));
    expect(screen.queryByText("origin/main")).not.toBeInTheDocument();
  });

  it("splitting the pill never selects the row or checks anything out", () => {
    const onSelect = vi.fn();
    const checkoutBranch = vi.fn();
    useRepo.setState({ checkoutBranch });
    render(<CommitRow {...baseProps} onSelect={onSelect} commit={groupedCommit()} />);

    fireEvent.click(screen.getByTitle("main — local + 1 remote in sync (click to split)"));

    expect(onSelect).not.toHaveBeenCalled();
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("right-clicking the collapsed pill opens the LOCAL branch's context menu", () => {
    render(<CommitRow {...baseProps} commit={groupedCommit()} />);
    fireEvent.contextMenu(screen.getByTitle("main — local + 1 remote in sync (click to split)"));

    expect(useUi.getState().contextMenu).toMatchObject({ branch: "main", isCurrent: true });
    expect(useUi.getState().commitMenu).toBeNull();
  });

  it("shows the worktree glyph on the collapsed pill when its local branch lives elsewhere", () => {
    // A non-current grouped branch checked out in another worktree: the
    // collapsed pill swaps the branch-fork glyph (r=3 circles) for the
    // worktree TreeIcon (r=2.5 circles).
    useRepo.setState({
      worktrees: [{ name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false }],
    });
    render(
      <CommitRow
        {...baseProps}
        commit={commit({
          refs: [
            { name: "feature", kind: "branch" },
            { name: "origin/feature", kind: "remote" },
          ],
        })}
      />,
    );

    const collapsed = screen.getByTitle("feature — local + 1 remote in sync (click to split)");
    expect(collapsed.querySelector('circle[r="2.5"]')).not.toBeNull();
    expect(collapsed.querySelector('circle[r="3"]')).toBeNull();
  });

  it("drags the collapsed pill as the local branch", () => {
    render(<CommitRow {...baseProps} commit={groupedCommit()} />);
    fireEvent.dragStart(screen.getByTitle("main — local + 1 remote in sync (click to split)"), {
      dataTransfer: dataTransfer(),
    });
    expect(useUi.getState().draggingFrom).toEqual({ name: "main", kind: "local" });
  });
});

describe("CommitRow row behavior", () => {
  it("selects with modifier flags on click", () => {
    const onSelect = vi.fn();
    render(<CommitRow {...baseProps} onSelect={onSelect} commit={commit()} />);

    fireEvent.click(screen.getByText("a commit"), { shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith("c1", { shift: true, additive: false });

    fireEvent.click(screen.getByText("a commit"), { metaKey: true });
    expect(onSelect).toHaveBeenLastCalledWith("c1", { shift: false, additive: true });

    // ctrl is the Windows/Linux additive modifier — same flag as meta.
    fireEvent.click(screen.getByText("a commit"), { ctrlKey: true });
    expect(onSelect).toHaveBeenLastCalledWith("c1", { shift: false, additive: true });
  });

  it("selects from the keyboard with Enter and Space, carrying modifiers", () => {
    const onSelect = vi.fn();
    const { container } = render(<CommitRow {...baseProps} onSelect={onSelect} commit={commit()} />);
    const row = container.firstElementChild as HTMLElement;

    fireEvent.keyDown(row, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("c1", { shift: false, additive: false });

    fireEvent.keyDown(row, { key: " ", shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith("c1", { shift: true, additive: false });

    // Other keys are ignored — arrow navigation belongs to the workspace.
    onSelect.mockClear();
    fireEvent.keyDown(row, { key: "ArrowDown" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens the commit context menu for this row and selects it if unselected", () => {
    const onSelect = vi.fn();
    render(<CommitRow {...baseProps} onSelect={onSelect} commit={commit()} />);
    fireEvent.contextMenu(screen.getByText("a commit"));

    expect(useUi.getState().commitMenu).toMatchObject({ sha: "c1", shortSha: "c1" });
    expect(onSelect).toHaveBeenCalledWith("c1", {});
  });

  it("keeps the existing multi-selection when right-clicking inside it", () => {
    const onSelect = vi.fn();
    useRepo.setState({ selectedCommits: ["c0", "c1"] });
    render(<CommitRow {...baseProps} onSelect={onSelect} commit={commit()} />);
    fireEvent.contextMenu(screen.getByText("a commit"));

    // The row is already part of the selection — no reselect that would
    // collapse the multi-selection down to one commit.
    expect(onSelect).not.toHaveBeenCalled();
    expect(useUi.getState().commitMenu).toMatchObject({ sha: "c1" });
  });

  it("accepts a dropped LOCAL branch and opens the action menu on this commit", () => {
    useUi.setState({ draggingFrom: { name: "feature", kind: "local" } });
    render(<CommitRow {...baseProps} commit={commit()} />);
    fireEvent.drop(screen.getByText("a commit"), { dataTransfer: dataTransfer() });

    expect(useUi.getState().actionMenu).toMatchObject({
      from: { name: "feature", kind: "local" },
      to: { kind: "commit", sha: "c1", shortSha: "c1" },
    });
    expect(useUi.getState().draggingFrom).toBeNull();
  });

  it("ignores a dropped REMOTE ref — commits are never targets for read-only refs", () => {
    useUi.setState({ draggingFrom: { name: "origin/feature", kind: "remote" } });
    render(<CommitRow {...baseProps} commit={commit()} />);
    fireEvent.drop(screen.getByText("a commit"), { dataTransfer: dataTransfer() });

    expect(useUi.getState().actionMenu).toBeNull();
    expect(useUi.getState().draggingFrom).toEqual({ name: "origin/feature", kind: "remote" });
  });

  it("fades a dimmed row unless it is selected or focused", () => {
    const { container, rerender } = render(
      <CommitRow {...baseProps} dimmed commit={commit()} />,
    );
    expect((container.firstElementChild as HTMLElement).className).toContain("opacity-25");

    rerender(<CommitRow {...baseProps} dimmed selected commit={commit()} />);
    expect((container.firstElementChild as HTMLElement).className).not.toContain("opacity-25");

    rerender(<CommitRow {...baseProps} dimmed focused commit={commit()} />);
    expect((container.firstElementChild as HTMLElement).className).not.toContain("opacity-25");
  });
});
