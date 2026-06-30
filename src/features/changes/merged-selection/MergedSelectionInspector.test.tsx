import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { CommitNode, FileChange, RepoGraph } from "../../../lib/api";
import { useRepo } from "../../../store/repo";
import { useUi } from "../../../store/ui";
import { MergedSelectionInspector } from "./MergedSelectionInspector";

const commit = (over: Partial<CommitNode>): CommitNode => ({
  id: "c",
  shortId: "c",
  summary: "",
  body: "",
  authorName: "Ada",
  authorEmail: "",
  timestamp: 0,
  parents: [],
  lane: 0,
  row: 0,
  color: 0,
  refs: [],
  ...over,
});

const graph: RepoGraph = {
  commits: [
    commit({ id: "c3", shortId: "abc3", summary: "third commit", timestamp: 30 }),
    commit({ id: "c2", shortId: "abc2", summary: "second commit", timestamp: 20 }),
    commit({ id: "c1", shortId: "abc1", summary: "first commit", timestamp: 10 }),
  ],
  edges: [],
  laneCount: 1,
  head: "c3",
  truncated: false,
};

const file = (path: string, status: FileChange["status"]): FileChange => ({
  path,
  status,
  add: 1,
  del: 0,
  binary: false,
});

beforeEach(() => {
  useRepo.setState({ graph, selectedFile: null });
  useUi.setState({ fileMenu: null, stackedReview: null });
});

describe("MergedSelectionInspector", () => {
  it("renders the count header, commit list and merged file list for a contiguous selection", () => {
    useRepo.setState({
      selectedCommits: ["c3", "c2", "c1"],
      selectionDiff: {
        commits: ["c3", "c2", "c1"],
        range: { base: "c0", head: "c3" },
        files: [file("src/app.ts", "M"), file("src/new.ts", "A")],
        loading: false,
        error: null,
      },
    });

    render(<MergedSelectionInspector />);

    expect(screen.getByText("3 commits selected")).toBeInTheDocument();
    expect(screen.getByText("Viewing merged diff of 3 commits")).toBeInTheDocument();
    // The selected commits are listed (newest first).
    expect(screen.getByText("third commit")).toBeInTheDocument();
    expect(screen.getByText("first commit")).toBeInTheDocument();
    // The aggregated file list and review entry are present.
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(screen.getByText("review all →")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tree" })).toBeInTheDocument();
  });

  it("shows the non-contiguous hint and no file list when the selection has no range", () => {
    useRepo.setState({
      selectedCommits: ["c3", "c1"],
      selectionDiff: {
        commits: ["c3", "c1"],
        range: null,
        files: [],
        loading: false,
        error: null,
      },
    });

    render(<MergedSelectionInspector />);

    expect(screen.getByText("2 commits selected")).toBeInTheDocument();
    expect(screen.getByText(/isn't a contiguous range/i)).toBeInTheDocument();
    expect(screen.queryByText("review all →")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tree" })).not.toBeInTheDocument();
  });
});
