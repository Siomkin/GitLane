import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitNode, FileChange, RepoGraph, StashEntry } from "@/lib/api";
import { BranchKind } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi, fileMenuOf, FileMenuKind } from "@/store/ui";
import { FileListView } from "@/lib/ui";
import { CommitInspector } from "./CommitInspector";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const commit = (over: Partial<CommitNode>): CommitNode => ({
  id: "c1",
  shortId: "c1",
  summary: "graph commit",
  body: "",
  authorName: "Ada",
  authorEmail: "ada@example.test",
  timestamp: 1,
  parents: [],
  lane: 0,
  row: 0,
  refs: [],
  ...over,
});

const graph: RepoGraph = {
  commits: [commit({ id: "c1", shortId: "c1", summary: "wrong fallback commit" })],
  edges: [],
  laneCount: 1,
  wipLane: null,
  head: "c1",
  truncated: false,
};

const stash: StashEntry = {
  index: 2,
  message: "On feature: WIP stash",
  oid: "stash-oid",
  timestamp: 2,
  baseOid: "base-commit",
  baseTimestamp: 1,
  context: [],
};

const file: FileChange = { path: "src/stashed.ts", status: "M", add: 3, del: 1, binary: false };

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  useRepo.setState({
    summary: null,
    graph,
    stashes: [stash],
    selectedCommit: "stash-oid",
    selectedCommits: ["stash-oid"],
    inspectParentIndex: 0,
    commitFiles: [file],
    selectedFile: null,
    fileDiff: null,
    wipSelected: false,
    branches: [],
  });
  useUi.setState({
    menu: null,
    stackedReview: null,
    editCommitMessage: null,
    fileListView: FileListView.Path,
  });
});

describe("CommitInspector", () => {
  it("brands a known agent author with its glyph instead of generic initials", () => {
    const claude = commit({
      id: "cc",
      shortId: "cc",
      summary: "agent commit",
      authorName: "Claude",
      authorEmail: "noreply@anthropic.com",
    });
    useRepo.setState({
      graph: { ...graph, commits: [claude], head: "cc" },
      stashes: [],
      selectedCommit: "cc",
      selectedCommits: ["cc"],
      commitFiles: [],
    });

    const { container } = render(<CommitInspector />);
    // The author block resolves identity the same way as the graph node, so a
    // known agent shows its bundled glyph (an <img>) rather than "C".
    expect(container.querySelector("img")).toBeTruthy();
    expect(screen.getByText("noreply@anthropic.com")).toBeInTheDocument();
  });

  it("renders selected stash metadata and files instead of falling back to the first graph commit", () => {
    render(<CommitInspector />);

    expect(screen.getByText("On feature: WIP stash")).toBeInTheDocument();
    expect(screen.getByText("stashed.ts")).toBeInTheDocument();
    expect(screen.queryByText("wrong fallback commit")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Diff against parent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /review all/i })).toBeInTheDocument();
  });

  it("opens the shared commit-message editor for an unpublished HEAD commit", async () => {
    const user = userEvent.setup();
    const selected = commit({
      id: "c1",
      shortId: "c1",
      summary: "fix(ui): old subject",
      body: "Existing body.",
    });
    useRepo.setState({
      summary: {
        path: "/repo",
        workdir: "/repo",
        headBranch: "main",
        headOid: "c1",
        detached: false,
      },
      graph: { ...graph, commits: [selected], head: "c1" },
      stashes: [],
      selectedCommit: "c1",
      selectedCommits: ["c1"],
      commitFiles: [],
    });
    render(<CommitInspector />);

    await user.dblClick(screen.getByRole("heading", { name: "fix(ui): old subject" }));

    expect(useUi.getState().editCommitMessage).toMatchObject({
      message: "This commit has not been pushed.",
      defaultValue: "fix(ui): old subject\n\nExisting body.",
    });
  });

  it("treats an in-window stash that is also a graph node as a stash, not a commit", () => {
    // In-window stashes are injected into graph.commits as nodes (with a `stash`
    // marker). Selecting one must still render StashMeta — not a commit row with
    // blank author — even though it now matches a node in graph.commits.
    useRepo.setState({
      graph: {
        ...graph,
        commits: [
          commit({ id: "stash-oid", summary: "stash-as-commit", authorName: "", stash: { index: 2, message: "On feature: WIP stash" } }),
          commit({ id: "c1", summary: "wrong fallback commit" }),
        ],
      },
    });

    render(<CommitInspector />);

    expect(screen.getByText("On feature: WIP stash")).toBeInTheDocument();
    expect(screen.queryByText("stash-as-commit")).not.toBeInTheDocument();
    expect(screen.queryByText("wrong fallback commit")).not.toBeInTheDocument();
  });

  it("offers a Path/Tree toggle that groups the changed files under a directory header", async () => {
    const user = userEvent.setup();
    render(<CommitInspector />);

    // Path mode by default: the basename is listed; no bare "src" directory row
    // (the flat row shows the dirname as "src/").
    expect(screen.getByText("stashed.ts")).toBeInTheDocument();
    expect(screen.queryByText("src")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tree" }));

    // Tree mode adds the collapsible directory header while keeping the file.
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("stashed.ts")).toBeInTheDocument();
  });

  it("synthesises stash metadata from the graph node when the stash list hasn't loaded", () => {
    // listStashes can lag the graph; the selected stash exists only as a node.
    useRepo.setState({
      stashes: [],
      graph: {
        ...graph,
        commits: [
          commit({ id: "stash-oid", summary: "stash-as-commit", authorName: "", parents: ["base-commit"], stash: { index: 2, message: "On feature: WIP stash" } }),
          commit({ id: "c1", summary: "wrong fallback commit" }),
        ],
      },
    });

    render(<CommitInspector />);

    // The synthesised stash's message drives the title (StashMeta path), and it
    // does not fall back to a commit. The `stash@{n}` pill lives in the header's
    // CommitCheckoutBar (covered in its own test).
    expect(screen.getByText("On feature: WIP stash")).toBeInTheDocument();
    expect(screen.queryByText("stash-as-commit")).not.toBeInTheDocument();
    expect(screen.queryByText("wrong fallback commit")).not.toBeInTheDocument();
  });

  it("filters changed files by name behind the reveal-on-demand field", async () => {
    const user = userEvent.setup();
    useRepo.setState({
      selectedCommit: "c1",
      selectedCommits: ["c1"],
      stashes: [],
      commitFiles: [
        { path: "src/Controller/SearchController.php", status: "M", add: 1, del: 0, binary: false },
        { path: "src/Service/SlotService.php", status: "M", add: 2, del: 1, binary: false },
        // Lives under a directory containing "search" — must NOT match, or one
        // folder hit would drag in every file beneath it.
        { path: "src/Search/Indexer.php", status: "M", add: 1, del: 0, binary: false },
      ],
    });
    render(<CommitInspector />);

    // Hidden until revealed; the eyebrow shows the plain count.
    expect(screen.queryByPlaceholderText(/Filter files/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Filter files" }));

    await user.type(screen.getByPlaceholderText(/Filter files/), "search");
    expect(screen.getByText(/Matching files/)).toBeInTheDocument();
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    // The name renders split around the highlight: <mark>Search</mark>Controller.php
    expect(screen.getByText("Search").tagName).toBe("MARK");
    expect(screen.getByText("Controller.php")).toBeInTheDocument();
    expect(screen.queryByText("SlotService.php")).not.toBeInTheDocument();
    expect(screen.queryByText("Indexer.php")).not.toBeInTheDocument();

    // Esc closes the field and restores the unfiltered list.
    await user.keyboard("{Escape}");
    expect(screen.queryByPlaceholderText(/Filter files/)).not.toBeInTheDocument();
    expect(screen.getByText("SlotService.php")).toBeInTheDocument();
  });

  it("clears the filter when a different commit is selected", async () => {
    const user = userEvent.setup();
    useRepo.setState({
      graph: {
        ...graph,
        commits: [commit({ id: "c1" }), commit({ id: "c2", shortId: "c2", summary: "second" })],
      },
      selectedCommit: "c1",
      selectedCommits: ["c1"],
      stashes: [],
      commitFiles: [
        { path: "src/a.ts", status: "M", add: 1, del: 0, binary: false },
        { path: "src/b.ts", status: "M", add: 1, del: 0, binary: false },
      ],
    });
    render(<CommitInspector />);

    await user.click(screen.getByRole("button", { name: "Filter files" }));
    await user.type(screen.getByPlaceholderText(/Filter files/), "a.ts");
    expect(screen.queryByText("b.ts")).not.toBeInTheDocument();

    // Switching commits must not carry the stale query to the new file list.
    act(() => useRepo.setState({ selectedCommit: "c2", selectedCommits: ["c2"] }));
    expect(screen.queryByPlaceholderText(/Filter files/)).not.toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
  });

  it("shows a clearable empty state when nothing matches the filter", async () => {
    const user = userEvent.setup();
    useRepo.setState({
      selectedCommit: "c1",
      selectedCommits: ["c1"],
      stashes: [],
      commitFiles: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
    });
    render(<CommitInspector />);

    await user.click(screen.getByRole("button", { name: "Filter files" }));
    await user.type(screen.getByPlaceholderText(/Filter files/), "nope");
    expect(screen.getByText(/No files match/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(screen.queryByPlaceholderText(/Filter files/)).not.toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
  });

  it("opens the file menu with Restore for a modified commit file", async () => {
    const user = userEvent.setup();
    useRepo.setState({
      selectedCommit: "c1",
      selectedCommits: ["c1"],
      stashes: [],
      commitFiles: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
    });
    render(<CommitInspector />);

    await user.pointer({ keys: "[MouseRight>]", target: screen.getByText("a.ts") });
    expect(fileMenuOf(useUi.getState())).toEqual(
      expect.objectContaining({
        kind: FileMenuKind.Committed,
        path: "src/a.ts",
        restore: { commitOid: "c1" },
      }),
    );
  });

  it("omits Restore for a deleted commit file", async () => {
    const user = userEvent.setup();
    useRepo.setState({
      selectedCommit: "c1",
      selectedCommits: ["c1"],
      stashes: [],
      commitFiles: [{ path: "gone.ts", status: "D", add: 0, del: 1, binary: false }],
    });
    render(<CommitInspector />);

    await user.pointer({ keys: "[MouseRight>]", target: screen.getByText("gone.ts") });
    // The committed variant carries no `restore` when the blob is absent.
    expect(fileMenuOf(useUi.getState())).toEqual({
      kind: FileMenuKind.Committed,
      x: expect.any(Number),
      y: expect.any(Number),
      path: "gone.ts",
    });
  });

  it("omits Restore for a submodule gitlink row", async () => {
    const user = userEvent.setup();
    useRepo.setState({
      selectedCommit: "c1",
      selectedCommits: ["c1"],
      stashes: [],
      commitFiles: [
        {
          path: "vendor/sub",
          status: "A",
          add: 0,
          del: 0,
          binary: false,
          advanced: { kind: "submodule", message: "Submodule gitlink" },
        },
      ],
    });
    render(<CommitInspector />);

    await user.pointer({ keys: "[MouseRight>]", target: screen.getByText("sub") });
    expect(fileMenuOf(useUi.getState())).toEqual({
      kind: FileMenuKind.Committed,
      x: expect.any(Number),
      y: expect.any(Number),
      path: "vendor/sub",
    });
  });

  it("lists an untracked stash file with a U badge in Changed files", () => {
    useRepo.setState({
      commitFiles: [
        { path: "src/stashed.ts", status: "M", add: 3, del: 1, binary: false },
        { path: "src/new.test.ts", status: "U", add: 12, del: 0, binary: false },
      ],
    });
    render(<CommitInspector />);

    expect(screen.getByText(/Changed files/)).toBeInTheDocument();
    expect(screen.getByText("new.test.ts")).toBeInTheDocument();
    expect(screen.getByText("U")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Diff against parent" })).not.toBeInTheDocument();
  });

  it("shows one unlabeled parent for a single-parent commit and no picker", () => {
    const selected = commit({
      id: "c1",
      shortId: "c1",
      summary: "ordinary",
      parents: ["aaaaaaaaaaaaaaaa"],
    });
    useRepo.setState({
      graph: { ...graph, commits: [selected], head: "c1" },
      stashes: [],
      selectedCommit: "c1",
      selectedCommits: ["c1"],
      commitFiles: [{ path: "src/a.ts", status: "M", add: 1, del: 0, binary: false }],
    });
    render(<CommitInspector />);

    expect(screen.getByText("parent")).toBeInTheDocument();
    expect(screen.getByText("aaaaaaa")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Diff against parent" })).not.toBeInTheDocument();
  });

  it("lists every merge parent with short sha and ref name, defaulting to the first", () => {
    const merge = commit({
      id: "ccc3333ffffff",
      shortId: "ccc3333",
      summary: "Merged develop into my-feature",
      parents: ["aaa1111ffffff", "bbb2222ffffff"],
    });
    useRepo.setState({
      graph: { ...graph, commits: [merge], head: "ccc3333ffffff" },
      stashes: [],
      selectedCommit: "ccc3333ffffff",
      selectedCommits: ["ccc3333ffffff"],
      inspectParentIndex: 0,
      branches: [
        { name: "my-feature", kind: BranchKind.Local, target: "aaa1111ffffff", isHead: true, upstream: null, remote: null },
        { name: "develop", kind: BranchKind.Local, target: "bbb2222ffffff", isHead: false, upstream: null, remote: null },
      ],
      commitFiles: Array.from({ length: 5 }, (_, i) => ({
        path: `incoming/${i}.ts`,
        status: "M" as const,
        add: 1,
        del: 0,
        binary: false,
      })),
    });
    render(<CommitInspector />);

    const first = screen.getByRole("button", { name: "aaa1111 · my-feature" });
    const second = screen.getByRole("button", { name: "bbb2222 · develop" });
    expect(first).toHaveAttribute("aria-pressed", "true");
    expect(second).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTitle("5 modified")).toBeInTheDocument();
  });

  it("reloads the feature-scope file list when the second parent is selected", async () => {
    const user = userEvent.setup();
    const merge = commit({
      id: "ccc3333ffffff",
      shortId: "ccc3333",
      summary: "Merged develop into my-feature",
      parents: ["aaa1111ffffff", "bbb2222ffffff"],
    });
    const firstParentFiles = Array.from({ length: 5 }, (_, i) => ({
      path: `incoming/${i}.ts`,
      status: "M" as const,
      add: 1,
      del: 0,
      binary: false,
    }));
    const developFiles = [
      { path: "ticket/a.ts", status: "M" as const, add: 1, del: 0, binary: false },
      { path: "ticket/b.ts", status: "M" as const, add: 1, del: 0, binary: false },
    ];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "diff_range") return Promise.resolve(developFiles);
      if (cmd === "commit_files") return Promise.resolve(firstParentFiles);
      return Promise.resolve([]);
    });
    useRepo.setState({
      summary: {
        path: "/repo",
        workdir: "/repo",
        headBranch: "my-feature",
        headOid: "ccc3333ffffff",
        detached: false,
      },
      graph: { ...graph, commits: [merge], head: "ccc3333ffffff" },
      stashes: [],
      selectedCommit: "ccc3333ffffff",
      selectedCommits: ["ccc3333ffffff"],
      inspectParentIndex: 0,
      branches: [
        { name: "develop", kind: BranchKind.Local, target: "bbb2222ffffff", isHead: false, upstream: null, remote: null },
      ],
      commitFiles: firstParentFiles,
    });
    render(<CommitInspector />);
    expect(screen.getByTitle("5 modified")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "bbb2222 · develop" }));

    expect(invokeMock).toHaveBeenCalledWith(
      "diff_range",
      expect.objectContaining({
        path: "/repo",
        base: "bbb2222ffffff",
        head: "ccc3333ffffff",
      }),
    );
    expect(await screen.findByTitle("2 modified")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
    expect(screen.queryByText("0.ts")).not.toBeInTheDocument();
  });

  it("opens a parentN..merge range review when Review all is used on a non-first parent", async () => {
    const user = userEvent.setup();
    const merge = commit({
      id: "ccc3333ffffff",
      shortId: "ccc3333",
      summary: "Merged develop into my-feature",
      parents: ["aaa1111ffffff", "bbb2222ffffff"],
    });
    useRepo.setState({
      graph: { ...graph, commits: [merge], head: "ccc3333ffffff" },
      stashes: [],
      selectedCommit: "ccc3333ffffff",
      selectedCommits: ["ccc3333ffffff"],
      inspectParentIndex: 1,
      commitFiles: [{ path: "ticket/a.ts", status: "M", add: 1, del: 0, binary: false }],
    });
    render(<CommitInspector />);

    await user.click(screen.getByRole("button", { name: /review all/i }));

    expect(useUi.getState().stackedReview).toEqual({
      kind: "range",
      base: "bbb2222ffffff",
      head: "ccc3333ffffff",
      title: "Reviewing 1 file · ccc3333",
    });
  });

  it("keeps Review all on a first-parent commit review", async () => {
    const user = userEvent.setup();
    const merge = commit({
      id: "ccc3333ffffff",
      shortId: "ccc3333",
      summary: "Merged develop into my-feature",
      parents: ["aaa1111ffffff", "bbb2222ffffff"],
    });
    useRepo.setState({
      graph: { ...graph, commits: [merge], head: "ccc3333ffffff" },
      stashes: [],
      selectedCommit: "ccc3333ffffff",
      selectedCommits: ["ccc3333ffffff"],
      inspectParentIndex: 0,
      commitFiles: [{ path: "incoming/a.ts", status: "M", add: 1, del: 0, binary: false }],
    });
    render(<CommitInspector />);

    await user.click(screen.getByRole("button", { name: /review all/i }));

    expect(useUi.getState().stackedReview).toEqual({
      kind: "commit",
      oid: "ccc3333ffffff",
      title: "Reviewing 1 file · ccc3333",
    });
  });
});
