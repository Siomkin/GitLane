import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitNode, RepoGraph } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { CommitCheckoutBar } from "./CommitCheckoutBar";

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
  commits: [commit({ id: "c1", shortId: "c1", summary: "real commit" })],
  edges: [],
  laneCount: 1,
  wipLane: null,
  head: "c1",
  truncated: false,
};

beforeEach(() => {
  useRepo.setState({ graph, stashes: [], selectedCommit: "c1", selectedCommits: ["c1"] });
});

describe("CommitCheckoutBar", () => {
  it("renders nothing when no commit is selected", () => {
    useRepo.setState({ graph: null, selectedCommit: null });
    const { container } = render(<CommitCheckoutBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("falls back to the first non-stash commit when nothing is explicitly selected", () => {
    useRepo.setState({
      graph: {
        ...graph,
        commits: [commit({ id: "head", shortId: "head", summary: "tip" })],
      },
      selectedCommit: null,
    });
    render(<CommitCheckoutBar />);
    expect(screen.getByRole("button", { name: "Copy SHA" })).toHaveTextContent("commit head");
  });

  it("copies the SHA when the pill is clicked, with inline confirmation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CommitCheckoutBar />);

    const pill = screen.getByRole("button", { name: "Copy SHA" });
    expect(pill).toHaveTextContent("commit c1");
    fireEvent.click(pill);
    expect(writeText).toHaveBeenCalledWith("c1");
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy SHA" })).not.toBeInTheDocument();
  });

  it("does not claim Copied when the clipboard write rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CommitCheckoutBar />);

    fireEvent.click(screen.getByRole("button", { name: "Copy SHA" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("c1"));
    await Promise.resolve();
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy SHA" })).toBeInTheDocument();
  });

  it("checks out the selected commit (detached) on Checkout", () => {
    const checkoutDetached = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ checkoutDetached });
    render(<CommitCheckoutBar />);

    fireEvent.click(screen.getByRole("button", { name: "Checkout" }));
    expect(checkoutDetached).toHaveBeenCalledWith("c1");
  });

  it("shows the stash label without a Checkout for a selected stash", () => {
    useRepo.setState({
      graph: {
        ...graph,
        commits: [
          commit({ id: "s1", summary: "stash", authorName: "", stash: { index: 2, message: "WIP" } }),
        ],
      },
      selectedCommit: "s1",
    });
    render(<CommitCheckoutBar />);

    expect(screen.getByText("stash@{2}")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Checkout" })).not.toBeInTheDocument();
  });
});
