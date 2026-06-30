import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitNode, FileChange, RepoGraph, StashEntry } from "../../lib/api";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { CommitInspector } from "./CommitInspector";

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
  color: 0,
  refs: [],
  ...over,
});

const graph: RepoGraph = {
  commits: [commit({ id: "c1", shortId: "c1", summary: "wrong fallback commit" })],
  edges: [],
  laneCount: 1,
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
  useRepo.setState({
    graph,
    stashes: [stash],
    selectedCommit: "stash-oid",
    selectedCommits: ["stash-oid"],
    commitFiles: [file],
    selectedFile: null,
    fileDiff: null,
    wipSelected: false,
  });
  useUi.setState({ fileMenu: null, stackedReview: null });
});

describe("CommitInspector", () => {
  it("renders selected stash metadata and files instead of falling back to the first graph commit", () => {
    render(<CommitInspector />);

    expect(screen.getByText("stash@{2}")).toBeInTheDocument();
    expect(screen.getByText("On feature: WIP stash")).toBeInTheDocument();
    expect(screen.getByText("stashed.ts")).toBeInTheDocument();
    expect(screen.queryByText("wrong fallback commit")).not.toBeInTheDocument();
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

    expect(screen.getByText("stash@{2}")).toBeInTheDocument();
    expect(screen.getByText("On feature: WIP stash")).toBeInTheDocument();
    expect(screen.queryByText("stash-as-commit")).not.toBeInTheDocument();
    expect(screen.queryByText("wrong fallback commit")).not.toBeInTheDocument();
  });

  it("copies the SHA when the commit pill is clicked, with inline confirmation", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useRepo.setState({
      graph: { ...graph, commits: [commit({ id: "c1", shortId: "c1", summary: "real commit" })] },
      stashes: [],
      selectedCommit: "c1",
      selectedCommits: ["c1"],
    });
    render(<CommitInspector />);

    const pill = screen.getByRole("button", { name: "Copy SHA" });
    expect(pill).toHaveTextContent("commit c1");
    fireEvent.click(pill);
    expect(writeText).toHaveBeenCalledWith("c1");
    // Inline feedback replaces the old toast + separate button.
    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy SHA" })).not.toBeInTheDocument();
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

    expect(screen.getByText("stash@{2}")).toBeInTheDocument();
    expect(screen.getByText("On feature: WIP stash")).toBeInTheDocument();
    expect(screen.queryByText("stash-as-commit")).not.toBeInTheDocument();
    expect(screen.queryByText("wrong fallback commit")).not.toBeInTheDocument();
  });
});
