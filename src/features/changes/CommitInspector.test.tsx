import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
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

const file: FileChange = { path: "src/stashed.ts", status: "M", add: 3, del: 1 };

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
});
