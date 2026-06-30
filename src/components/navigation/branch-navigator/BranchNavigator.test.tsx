import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BranchInfo, CommitNode, RepoGraph, StashEntry } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { BranchNavigator } from "./BranchNavigator";

const branch = (name: string, kind: BranchInfo["kind"], over: Partial<BranchInfo> = {}): BranchInfo => ({
  name,
  kind,
  target: "c1",
  isHead: false,
  upstream: null,
  ...over,
});
const tagged: CommitNode = {
  id: "c1",
  shortId: "c1",
  summary: "",
  body: "",
  authorName: "",
  authorEmail: "",
  timestamp: 0,
  parents: [],
  lane: 0,
  row: 0,
  color: 0,
  refs: [{ name: "v1.0.0", kind: "tag" }],
};
const graph: RepoGraph = { commits: [tagged], edges: [], laneCount: 1, head: "c1", truncated: false };
const stash: StashEntry = {
  index: 0,
  message: "On feature: WIP stash",
  oid: "stash-oid",
  timestamp: 0,
  baseOid: "c1",
  baseTimestamp: 0,
  context: [],
};

// A matched label is split across <mark> highlight nodes, so match on full
// textContent and pick the innermost element, then climb to its row div.
const deepestWithText = (text: string) => {
  const all = screen.getAllByText((_, node) => node?.textContent?.trim() === text);
  return all.find((el) => !all.some((o) => o !== el && el.contains(o)))!;
};
const rowFor = (label: string) => deepestWithText(label).closest("div")!;

beforeEach(() => {
  useRepo.setState({
    summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
    graph,
    branches: [branch("main", "local"), branch("feature/search", "local")],
    worktrees: [],
    stashes: [],
    selectedCommit: null,
    selectedCommits: [],
    commitFiles: [],
    revealTarget: null,
  });
  useUi.setState({ filter: "", navOpen: true, stackedReview: null });
});

describe("BranchNavigator", () => {
  it("renders every branch with no dimming when the search box is empty", () => {
    render(<BranchNavigator />);
    expect(rowFor("main").className).not.toMatch(/opacity-25/);
    expect(rowFor("feature/search").className).not.toMatch(/opacity-25/);
    expect(screen.queryByText("No matches")).not.toBeInTheDocument();
  });

  it("shows local branch sync badges", () => {
    useRepo.setState({
      branches: [
        branch("main", "local", {
          upstream: "origin/main",
          sync: { status: "ahead", upstream: "origin/main", ahead: 2, behind: 0 },
        }),
      ],
    });

    render(<BranchNavigator />);

    expect(screen.getByText("↑2")).toHaveAttribute("title", "2 commits ahead of origin/main.");
  });

  it("shows only matching rows while searching", () => {
    useUi.setState({ filter: "feature" });
    render(<BranchNavigator />);
    expect(rowFor("feature/search").className).not.toMatch(/opacity-25/);
    expect(screen.queryByText("main")).not.toBeInTheDocument();
    expect(screen.queryByText("No matches")).not.toBeInTheDocument();
    // The matched fragment of the name is highlighted (query is 3+ chars).
    const marks = Array.from(rowFor("feature/search").querySelectorAll("mark")).map((m) => m.textContent);
    expect(marks).toEqual(["feature"]);
  });

  it("clears the branch search from the inline reset button", () => {
    useUi.setState({ filter: "feature" });
    render(<BranchNavigator />);

    fireEvent.click(screen.getByRole("button", { name: "Clear branch search" }));

    expect(useUi.getState().filter).toBe("");
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("feature/search")).toBeInTheDocument();
  });

  it("shows a 'No matches' hint and hides rows when nothing matches", () => {
    useUi.setState({ filter: "zzz-nope" });
    render(<BranchNavigator />);
    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.queryByText("main")).not.toBeInTheDocument();
    expect(screen.queryByText("feature/search")).not.toBeInTheDocument();
  });

  it("shows worktrees with their path, flags the open one, and switches to a linked one on click", () => {
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      worktrees: [
        { name: "r", path: "/r", branch: "main", isMain: true },
        { name: "r-wt", path: "/work/r-wt", branch: "feature/search", isMain: false },
      ],
      openWorktree,
    });
    render(<BranchNavigator />);

    // The absolute path is shown as secondary text so sibling worktrees are
    // distinguishable; the open ("current") worktree is flagged.
    expect(screen.getByText("/work/r-wt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Current worktree main" })).toBeInTheDocument();

    // Left-click on a non-active worktree switches the app to it and closes the nav.
    fireEvent.click(screen.getByRole("button", { name: "Open worktree feature/search" }));
    expect(openWorktree).toHaveBeenCalledWith("/work/r-wt");
    expect(useUi.getState().navOpen).toBe(false);
  });

  it("disambiguates codex worktrees that share the repo name as their directory", () => {
    useRepo.setState({
      summary: { path: "/Volumes/Dev/GitLane", workdir: "/Volumes/Dev/GitLane", headBranch: "main", headOid: "c1", detached: false },
      worktrees: [
        { name: "GitLane", path: "/Volumes/Dev/GitLane", branch: "main", isMain: true },
        { name: "GitLane", path: "/Users/me/.codex/worktrees/1e75/GitLane", branch: null, isMain: false },
      ],
    });
    render(<BranchNavigator />);

    // The detached codex worktree's leaf is "GitLane" (the repo name), so the row
    // falls back to "<parent>/<leaf>" to stay distinguishable; the main keeps its branch.
    expect(screen.getByRole("button", { name: "Open worktree 1e75/GitLane" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Current worktree main" })).toBeInTheDocument();
  });

  it("surfaces a failed worktree switch as an error toast", async () => {
    const openWorktree = vi.fn().mockRejectedValue(new Error("worktree gone"));
    useRepo.setState({
      worktrees: [
        { name: "r", path: "/r", branch: "main", isMain: true },
        { name: "r-wt", path: "/work/r-wt", branch: "feature/search", isMain: false },
      ],
      openWorktree,
    });
    render(<BranchNavigator />);

    fireEvent.click(screen.getByRole("button", { name: "Open worktree feature/search" }));

    await waitFor(() => expect(useUi.getState().toast?.message).toContain("worktree gone"));
    expect(useUi.getState().toast?.tone).toBe("error");
  });

  it("clicking a stash reveals it in history without opening its file review", () => {
    useRepo.setState({ stashes: [stash] });
    render(<BranchNavigator />);

    fireEvent.click(rowFor("On feature: WIP stash{0}"));

    expect(useRepo.getState().revealTarget).toBe("stash-oid");
    expect(useRepo.getState().selectedCommit).toBeNull();
    expect(useUi.getState().stackedReview).toBeNull();
    expect(useUi.getState().navOpen).toBe(false);
  });
});
