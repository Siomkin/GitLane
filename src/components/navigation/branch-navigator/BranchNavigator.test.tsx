import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { BranchInfo, CommitNode, RepoGraph, StashEntry } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useNotifications } from "@/store/notifications";
import { BranchNavigator } from "./BranchNavigator";

const branch = (name: string, kind: BranchInfo["kind"], over: Partial<BranchInfo> = {}): BranchInfo => ({
  name,
  kind,
  target: "c1",
  isHead: false,
  upstream: null,
  remote: null,
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
  useUi.setState({
    filter: "",
    navOpen: true,
    stackedReview: null,
    pinnedNavRefsByRepo: {},
    createBranchOpen: false,
    createBranchName: null,
  });
  useNotifications.setState({ toasts: [] });
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

  it("shows the empty state and hides rows when nothing matches", () => {
    useUi.setState({ filter: "zzz-nope" });
    render(<BranchNavigator />);
    expect(screen.getByText("No ref matches", { exact: false, selector: "p" })).toBeInTheDocument();
    expect(screen.queryByText("main")).not.toBeInTheDocument();
    expect(screen.queryByText("feature/search")).not.toBeInTheDocument();
  });

  it("names an empty category without doubling its plural", () => {
    // The repo has branches but no tags, so the Tags category is empty while the
    // navigator is not: the copy must read "No tags yet", never "No tagss yet".
    useRepo.setState({ graph: { ...graph, commits: [{ ...tagged, refs: [] }] } });
    render(<BranchNavigator />);

    fireEvent.click(screen.getByRole("button", { name: /^Tags/ }));

    expect(screen.getByText("No tags yet")).toBeInTheDocument();
  });

  it("offers to create a branch named after an unmatched query, prefilled", () => {
    useUi.setState({ filter: "feat/new-thing" });
    render(<BranchNavigator />);

    fireEvent.click(screen.getByRole("button", { name: /Create branch/ }));

    // Hands off to the existing create-branch dialog (branches from HEAD) with
    // the query as the proposed name; the popup closes under it.
    expect(useUi.getState().createBranchOpen).toBe(true);
    expect(useUi.getState().createBranchStart).toBeNull();
    expect(useUi.getState().createBranchName).toBe("feat/new-thing");
    expect(useUi.getState().navOpen).toBe(false);
  });

  it("shows the match count beside the search box while filtering", () => {
    useUi.setState({ filter: "feature" });
    render(<BranchNavigator />);
    expect(screen.getByText("1 match")).toBeInTheDocument();
  });

  it("switches category from the sidebar, clearing the search, and shows that kind only", () => {
    useUi.setState({ filter: "feature" });
    render(<BranchNavigator />);

    fireEvent.click(screen.getByRole("button", { name: /^Tags/ }));

    expect(useUi.getState().filter).toBe("");
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
    expect(screen.queryByText("main")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Filter tags")).toBeInTheDocument();
  });

  it("sorts a pinned branch above unpinned ones with a separator, current first", () => {
    useRepo.setState({
      branches: [
        branch("alpha", "local"),
        branch("main", "local"),
        branch("zulu", "local"),
      ],
    });
    useUi.setState({ pinnedNavRefsByRepo: { "/r": { "local|zulu": true } } });
    render(<BranchNavigator />);

    const rows = screen
      .getAllByRole("button", { name: /^(Current|Reveal) local / })
      .map((el) => el.getAttribute("aria-label"));
    expect(rows).toEqual(["Current local main", "Reveal local zulu", "Reveal local alpha"]);
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("shows worktrees with their path, flags the open one, and reveals a linked one's tip on click", () => {
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

    // Left-click reveals the worktree's tip in the graph and closes the nav —
    // the same navigate-and-highlight behaviour as branch rows. It does NOT
    // switch the app to the worktree (that lives on the kebab menu now).
    fireEvent.click(screen.getByRole("button", { name: "Reveal worktree feature/search" }));
    expect(useRepo.getState().revealTarget).toBe("c1");
    expect(openWorktree).not.toHaveBeenCalled();
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
    expect(screen.getByRole("button", { name: "Reveal worktree 1e75/GitLane" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Current worktree main" })).toBeInTheDocument();
  });

  it("opens the worktree menu from the visible kebab without revealing the row", () => {
    useRepo.setState({
      worktrees: [
        { name: "r", path: "/r", branch: "main", isMain: true },
        { name: "r-wt", path: "/work/r-wt", branch: "feature/search", isMain: false },
      ],
    });
    render(<BranchNavigator />);

    // The kebab surfaces the same menu as right-click (open / copy path / remove).
    fireEvent.click(screen.getByRole("button", { name: "Worktree actions for feature/search" }));

    // It opens the menu with the row's payload and does NOT also trigger the
    // row's reveal click.
    expect(useUi.getState().worktreeMenu).toMatchObject({
      path: "/work/r-wt",
      name: "feature/search",
      isMain: false,
    });
    expect(useRepo.getState().revealTarget).toBeNull();
    expect(useUi.getState().navOpen).toBe(true);
  });

  it("flags a detached worktree with a badge and no badge on branched ones", () => {
    useRepo.setState({
      worktrees: [
        { name: "r", path: "/r", branch: "main", isMain: true },
        { name: "r-detached", path: "/work/r-detached", branch: null, head: "abc1234", isMain: false },
      ],
    });
    render(<BranchNavigator />);

    const badges = screen.getAllByTitle("Detached HEAD — no branch checked out");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent("detached");
    expect(rowFor("r-detached")).toContainElement(badges[0]);
  });

  it("offers the 'Remove detached' sweep only when a removable detached worktree exists", () => {
    useRepo.setState({
      worktrees: [
        { name: "r", path: "/r", branch: "main", isMain: true },
        { name: "r-wt", path: "/work/r-wt", branch: "feature/search", isMain: false },
      ],
    });
    const { unmount } = render(<BranchNavigator />);
    expect(screen.queryByRole("button", { name: "Remove all detached worktrees" })).not.toBeInTheDocument();
    unmount();

    useRepo.setState({
      worktrees: [
        { name: "r", path: "/r", branch: "main", isMain: true },
        { name: "a", path: "/work/a", branch: null, isMain: false },
        { name: "b", path: "/work/b", branch: null, isMain: false },
      ],
    });
    render(<BranchNavigator />);
    expect(screen.getByRole("button", { name: "Remove all detached worktrees" })).toHaveTextContent(
      "Remove detached (2)",
    );
  });

  it("opens the remove-detached dialog with the removable targets and closes the nav", () => {
    useRepo.setState({
      worktrees: [
        { name: "r", path: "/r", branch: "main", isMain: true },
        { name: "a", path: "/work/a", branch: null, isMain: false },
        { name: "c", path: "/work/c", branch: null, isMain: false },
        // A locked detached entry is NOT a bulk target (a force would override
        // git's dirty check) — it's removable one-by-one via the row menu.
        { name: "b", path: "/work/b", branch: null, isMain: false, locked: true },
        // A prunable detached entry is NOT a removable target (git prune, not remove).
        { name: "gone", path: "/work/gone", branch: null, isMain: false, prunable: true },
      ],
    });
    render(<BranchNavigator />);

    fireEvent.click(screen.getByRole("button", { name: "Remove all detached worktrees" }));

    // The sweep hands off to the dedicated progress dialog (no fire-and-forget
    // toast); it carries only the removable targets, and the popup closes under it.
    expect(useUi.getState().removeDetached?.targets.map((t) => t.path)).toEqual(["/work/a", "/work/c"]);
    expect(useUi.getState().navOpen).toBe(false);
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

  it("revealing a stash escapes higher-priority routes so history can consume it", () => {
    // A reveal from the navigator while an inspection view (compare / file
    // history) or another tab is up must route all the way back to the graph
    // — those views outrank the history tab in deriveCenterView, and while one
    // is mounted HistoryWorkspace can't scroll to (and consume) the target.
    useRepo.setState({
      stashes: [stash],
      compare: {
        base: "a",
        head: "b",
        baseLabel: "a",
        headLabel: "b",
        scope: "commit",
        title: "a..b",
        files: [],
        loading: false,
        error: null,
        add: 0,
        del: 0,
        ahead: 0,
        behind: 0,
        pathFilter: "",
        selectedPath: null,
        selectedDiff: null,
        diffLoading: false,
        diffError: null,
      },
    });
    useUi.setState({ leftTab: "pulls" });
    render(<BranchNavigator />);

    fireEvent.click(rowFor("On feature: WIP stash{0}"));

    expect(useRepo.getState().revealTarget).toBe("stash-oid");
    expect(useRepo.getState().compare).toBeNull();
    expect(useUi.getState().leftTab).toBe("history");
  });
});
