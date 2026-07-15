import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CommitNode, HistorySearchPage, RepoGraph } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { AdvancedHistorySearch } from "./AdvancedHistorySearch";

const realActions = {
  searchHistory: useRepo.getState().searchHistory,
  revealCommit: useRepo.getState().revealCommit,
  loadMoreHistory: useRepo.getState().loadMoreHistory,
};
const summaryFor = (path: string) => ({
  path,
  workdir: path,
  headBranch: "main",
  headOid: "c1",
  detached: false,
});
const pageWith = (id: string): HistorySearchPage => ({
  results: [{ id, shortId: id, summary: `commit ${id}`, authorName: "Ann", authorEmail: "ann@x", timestamp: 0 }],
  truncated: false,
});
const graphWith = (ids: string[]): RepoGraph => ({
  commits: ids.map((id) => ({ id, refs: [], authorName: "", authorEmail: "" }) as unknown as CommitNode),
  edges: [],
  laneCount: 1,
  head: ids[0] ?? null,
  truncated: false,
});
const messageInput = () => screen.getByPlaceholderText("regex — fix|refactor") as HTMLInputElement;
const resultButton = (label: string) => screen.getByText(label).closest("button") as HTMLButtonElement;

afterEach(() => {
  // The repo store is a singleton — undo the per-test summary/graph/action
  // overrides so the chip tests (default no-repo state) stay isolated.
  useRepo.setState({ summary: undefined, graph: null, ...realActions });
});

// The pure derivation is covered in advancedSearchModel.test.ts; this locks the
// interaction: a typed filter surfaces a removable chip, and its × clears the
// field. No repo/invoke setup needed — typing in Author never hits the backend.
describe("AdvancedHistorySearch filter chips", () => {
  it("shows a chip for a filled field and removes it (clearing the field) on ×", () => {
    render(<AdvancedHistorySearch />);
    const author = screen.getByPlaceholderText("name or email") as HTMLInputElement;
    fireEvent.change(author, { target: { value: "Ann" } });

    const remove = screen.getByRole("button", { name: "Remove Author: Ann filter" });
    expect(remove).toBeInTheDocument();

    fireEvent.click(remove);
    expect(author.value).toBe("");
    expect(screen.queryByRole("button", { name: "Remove Author: Ann filter" })).not.toBeInTheDocument();
  });

  it("clears every field with Clear all", () => {
    render(<AdvancedHistorySearch />);
    const message = screen.getByPlaceholderText("regex — fix|refactor") as HTMLInputElement;
    const author = screen.getByPlaceholderText("name or email") as HTMLInputElement;
    fireEvent.change(message, { target: { value: "fix" } });
    fireEvent.change(author, { target: { value: "Ann" } });

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(message.value).toBe("");
    expect(author.value).toBe("");
    expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
  });
});

// The advanced panel stays mounted across repo switches and its search/reveal
// are async, so its query text and results must not survive a repository switch
// or an out-of-order response (flagged by the agent review).
describe("AdvancedHistorySearch async isolation", () => {
  const runSearch = () => {
    fireEvent.change(messageInput(), { target: { value: "fix" } });
    fireEvent.click(screen.getByRole("button", { name: "Search repository" }));
  };

  it("clears the rendered results with Clear all", async () => {
    useRepo.setState({ summary: summaryFor("/a"), searchHistory: async () => pageWith("c1") });
    render(<AdvancedHistorySearch />);
    runSearch();
    await screen.findByText("commit c1");

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.queryByText("commit c1")).not.toBeInTheDocument();
  });

  it("resets the query and results when the repository switches", async () => {
    useRepo.setState({ summary: summaryFor("/a"), searchHistory: async () => pageWith("c1") });
    const { rerender } = render(<AdvancedHistorySearch />);
    runSearch();
    await screen.findByText("commit c1");

    // Switch repos — the panel stays mounted; the repoPath effect must reset it.
    act(() => useRepo.setState({ summary: summaryFor("/b") }));
    rerender(<AdvancedHistorySearch />);

    await waitFor(() => expect(messageInput().value).toBe(""));
    expect(screen.queryByText("commit c1")).not.toBeInTheDocument();
  });

  it("drops a search response that resolves after a repo switch", async () => {
    let resolveFirst: (page: HistorySearchPage) => void = () => {};
    const inFlight = new Promise<HistorySearchPage>((resolve) => (resolveFirst = resolve));
    useRepo.setState({ summary: summaryFor("/a"), searchHistory: () => inFlight });
    const { rerender } = render(<AdvancedHistorySearch />);
    runSearch(); // search against repo A, now pending

    // Repo B becomes active before the repo-A response lands.
    act(() => useRepo.setState({ summary: summaryFor("/b") }));
    rerender(<AdvancedHistorySearch />);

    // The stale repo-A response resolves — it must not render (generation guard).
    await act(async () => {
      resolveFirst(pageWith("stale"));
    });
    expect(screen.queryByText("commit stale")).not.toBeInTheDocument();
  });

  it("does not repopulate results when a search resolves after Clear all", async () => {
    let resolveSearch: (page: HistorySearchPage) => void = () => {};
    const inFlight = new Promise<HistorySearchPage>((resolve) => (resolveSearch = resolve));
    useRepo.setState({ summary: summaryFor("/a"), searchHistory: () => inFlight });
    render(<AdvancedHistorySearch />);
    runSearch(); // pending; the "fix" chip makes the Clear all button available

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await act(async () => {
      resolveSearch(pageWith("stale"));
    });
    expect(screen.queryByText("commit stale")).not.toBeInTheDocument();
  });

  it("re-enables result rows when a new search supersedes an in-flight reveal", async () => {
    let finishReveal: () => void = () => {};
    useRepo.setState({
      summary: summaryFor("/a"),
      searchHistory: async () => pageWith("c1"),
      graph: graphWith(["c1"]),
      revealCommit: () => new Promise<void>((resolve) => (finishReveal = resolve)),
    });
    render(<AdvancedHistorySearch />);
    runSearch();
    await screen.findByText("commit c1");

    // Start a reveal — it awaits revealCommit and disables the rows.
    fireEvent.click(resultButton("commit c1"));
    await waitFor(() => expect(resultButton("commit c1")).toBeDisabled());

    // A new search bumps the generation, superseding the reveal.
    runSearch();
    // The superseded reveal resolves — its finally must still clear `revealing`
    // so the rows become clickable again.
    await act(async () => {
      finishReveal();
    });
    await waitFor(() => expect(resultButton("commit c1")).not.toBeDisabled());
  });

  it("an older same-id reveal does not re-enable a newer reveal's row", async () => {
    const resolvers: Array<() => void> = [];
    useRepo.setState({
      summary: summaryFor("/a"),
      searchHistory: async () => pageWith("c1"),
      graph: graphWith(["c1"]),
      revealCommit: () => new Promise<void>((resolve) => resolvers.push(resolve)),
    });
    render(<AdvancedHistorySearch />);
    runSearch();
    await screen.findByText("commit c1");

    // Reveal A for c1 (awaits revealCommit → rows disabled).
    fireEvent.click(resultButton("commit c1"));
    await waitFor(() => expect(resultButton("commit c1")).toBeDisabled());

    // Clear all invalidates reveal A and re-enables the surface.
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(screen.queryByText("commit c1")).not.toBeInTheDocument());

    // Search again (returns c1) and start reveal B for the SAME id.
    runSearch();
    await screen.findByText("commit c1");
    fireEvent.click(resultButton("commit c1"));
    await waitFor(() => expect(resultButton("commit c1")).toBeDisabled());

    // Reveal A finally settles — per-invocation ownership means it must NOT
    // clear reveal B's busy state.
    await act(async () => resolvers[0]());
    expect(resultButton("commit c1")).toBeDisabled();

    // Reveal B settles — now the row re-enables.
    await act(async () => resolvers[1]());
    await waitFor(() => expect(resultButton("commit c1")).not.toBeDisabled());
  });
});
