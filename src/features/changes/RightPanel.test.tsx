import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitNode, RepoGraph } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { emptyChanges } from "@/store/repoTypes";
import { RightPanel } from "./RightPanel";

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
  color: 0,
  refs: [],
  ...over,
});

const graph: RepoGraph = {
  commits: [commit({ id: "c1", shortId: "c1", summary: "real commit" })],
  edges: [],
  laneCount: 1,
  head: "c1",
  truncated: false,
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  useRepo.setState({
    graph,
    stashes: [],
    selectedCommit: "c1",
    selectedCommits: ["c1"],
    commitFiles: [],
    changes: emptyChanges,
    wipSelected: false,
    repoFiles: null,
    fileView: null,
  });
  useUi.setState({ rightTab: "details", leftTab: "history" });
});

// The commit identity/Checkout bar in the header shows only when CommitInspector
// is the body — a single selected commit on the Details tab, nothing else.
describe("RightPanel header commit bar", () => {
  it("shows the pill + Checkout for a single selected commit on Details", () => {
    render(<RightPanel />);
    expect(screen.getByRole("button", { name: "Copy SHA" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Checkout" })).toBeInTheDocument();
  });

  it("hides it on the Files tab", () => {
    useUi.setState({ rightTab: "files" });
    render(<RightPanel />);
    expect(screen.queryByRole("button", { name: "Copy SHA" })).not.toBeInTheDocument();
  });

  it("hides it for a WIP selection", () => {
    useRepo.setState({ wipSelected: true });
    render(<RightPanel />);
    expect(screen.queryByRole("button", { name: "Copy SHA" })).not.toBeInTheDocument();
  });

  it("hides it for a multi-commit selection", () => {
    useRepo.setState({ selectedCommits: ["c1", "c2"] });
    render(<RightPanel />);
    expect(screen.queryByRole("button", { name: "Copy SHA" })).not.toBeInTheDocument();
  });

  it("hides it while the Changes tab is active", () => {
    useUi.setState({ leftTab: "changes" });
    render(<RightPanel />);
    expect(screen.queryByRole("button", { name: "Copy SHA" })).not.toBeInTheDocument();
  });
});
