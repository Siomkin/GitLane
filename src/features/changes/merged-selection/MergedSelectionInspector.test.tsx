import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitNode, FileChange, RepoGraph } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi, fileMenuOf, FileMenuKind } from "@/store/ui";
import { FileListView } from "@/lib/ui";
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
  wipLane: null,
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
  useUi.setState({ menu: null, stackedReview: null, fileListView: FileListView.Path });
});

describe("MergedSelectionInspector", () => {
  it("renders the count header, commit list and merged file list", () => {
    useRepo.setState({
      selectedCommits: ["c3", "c2", "c1"],
      selectionDiff: {
        commits: ["c3", "c2", "c1"],
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

  it("renders the merged list for a non-contiguous selection too (no hint)", () => {
    // A gapped pick (c3 + c1, skipping c2) still merges — the union is computed
    // by the backend, so the inspector shows the file list, never a hint.
    useRepo.setState({
      selectedCommits: ["c3", "c1"],
      selectionDiff: {
        commits: ["c3", "c1"],
        files: [file("src/app.ts", "M")],
        loading: false,
        error: null,
      },
    });

    render(<MergedSelectionInspector />);

    expect(screen.getByText("2 commits selected")).toBeInTheDocument();
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(screen.getByText("review all →")).toBeInTheDocument();
    expect(screen.queryByText(/contiguous range/i)).not.toBeInTheDocument();
  });

  it("shows a loading placeholder until the union arrives", () => {
    useRepo.setState({
      selectedCommits: ["c3", "c1"],
      selectionDiff: { commits: ["c3", "c1"], files: [], loading: true, error: null },
    });

    render(<MergedSelectionInspector />);

    expect(screen.getByText("Loading merged diff…")).toBeInTheDocument();
    expect(screen.queryByText("review all →")).not.toBeInTheDocument();
  });

  it("opens Restore from the newest selected commit when the tip owns the path", async () => {
    const user = userEvent.setup();
    // The tip commit (c3) has a restorable blob at the path.
    const probe = vi.fn().mockResolvedValue(true);
    useRepo.setState({
      selectedCommits: ["c3", "c1"],
      selectionDiff: {
        commits: ["c3", "c1"],
        files: [file("src/app.ts", "M")],
        loading: false,
        error: null,
      },
      commitPathIsRestorable: probe,
    });
    render(<MergedSelectionInspector />);

    await user.pointer({ keys: "[MouseRight>]", target: screen.getByText("app.ts") });
    await waitFor(() =>
      expect(fileMenuOf(useUi.getState())).toEqual(
        expect.objectContaining({ kind: FileMenuKind.Committed, path: "src/app.ts", restore: { commitOid: "c3" } }),
      ),
    );
    expect(probe).toHaveBeenCalledWith("c3", "src/app.ts");
  });

  it("omits Restore when the selection tip doesn't own the path", async () => {
    const user = userEvent.setup();
    // Non-contiguous selection where the path isn't present at the tip: the
    // per-file probe fails closed, so the menu opens without a Restore verb.
    const probe = vi.fn().mockResolvedValue(false);
    useRepo.setState({
      selectedCommits: ["c3", "c1"],
      selectionDiff: {
        commits: ["c3", "c1"],
        files: [file("src/app.ts", "M")],
        loading: false,
        error: null,
      },
      commitPathIsRestorable: probe,
    });
    render(<MergedSelectionInspector />);

    await user.pointer({ keys: "[MouseRight>]", target: screen.getByText("app.ts") });
    await waitFor(() =>
      expect(fileMenuOf(useUi.getState())).toEqual(
        expect.objectContaining({ kind: FileMenuKind.Committed, path: "src/app.ts" }),
      ),
    );
    expect(fileMenuOf(useUi.getState())).toEqual({
      kind: FileMenuKind.Committed,
      x: expect.any(Number),
      y: expect.any(Number),
      path: "src/app.ts",
    });
    expect(probe).toHaveBeenCalledWith("c3", "src/app.ts");
  });

  it("skips the probe entirely for a deleted-in-union path", async () => {
    const user = userEvent.setup();
    const probe = vi.fn().mockResolvedValue(true);
    useRepo.setState({
      selectedCommits: ["c3", "c1"],
      selectionDiff: {
        commits: ["c3", "c1"],
        files: [file("src/gone.ts", "D")],
        loading: false,
        error: null,
      },
      commitPathIsRestorable: probe,
    });
    render(<MergedSelectionInspector />);

    await user.pointer({ keys: "[MouseRight>]", target: screen.getByText("gone.ts") });
    await waitFor(() => expect(fileMenuOf(useUi.getState())?.path).toBe("src/gone.ts"));
    expect(fileMenuOf(useUi.getState())).toEqual({
      kind: FileMenuKind.Committed,
      x: expect.any(Number),
      y: expect.any(Number),
      path: "src/gone.ts",
    });
    // A "D" row can never restore, so the frontend never round-trips to probe it.
    expect(probe).not.toHaveBeenCalled();
  });
});
