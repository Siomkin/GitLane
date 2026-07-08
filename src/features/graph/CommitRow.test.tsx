import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitNode } from "../../lib/api";
import { useRepo } from "../../store/repo";
import { CommitRow } from "./CommitRow";

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
    checkoutBranch: realCheckoutBranch,
    checkoutRemoteBranch: realCheckoutRemoteBranch,
  });
});

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
});
