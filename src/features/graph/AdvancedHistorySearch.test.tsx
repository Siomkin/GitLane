import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CommitNode, HistorySearchPage, RepoGraph } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { AdvancedHistorySearch } from "./AdvancedHistorySearch";
import { datePlaceholders } from "./advancedSearchModel";

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
  workTruncated: false,
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
    const since = screen.getByLabelText("Committed after") as HTMLInputElement;
    fireEvent.change(message, { target: { value: "fix" } });
    fireEvent.change(author, { target: { value: "Ann" } });
    fireEvent.change(since, { target: { value: "2020-01-01" } });

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(message.value).toBe("");
    expect(author.value).toBe("");
    expect(since.value).toBe("");
    expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
  });

  it("flags an unparseable date instead of chip-ing or searching it", () => {
    render(<AdvancedHistorySearch />);
    const since = screen.getByLabelText("Committed after") as HTMLInputElement;
    fireEvent.change(since, { target: { value: "2223213123" } });

    // No lying chip for a value the query would drop; the field is flagged and
    // the search is blocked instead.
    expect(screen.queryByRole("button", { name: /Remove After/ })).not.toBeInTheDocument();
    expect(since).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Dates must be YYYY-MM-DD/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search repository" })).toBeDisabled();

    fireEvent.change(since, { target: { value: "2025-07-15" } });
    expect(screen.getByRole("button", { name: "Remove After 2025-07-15 filter" })).toBeInTheDocument();
    expect(since).not.toHaveAttribute("aria-invalid");
  });

  it("adopts the placeholder on Tab in an empty date field, but not on Shift+Tab or over a value", () => {
    render(<AdvancedHistorySearch />);
    const hints = datePlaceholders();
    const since = screen.getByLabelText("Committed after") as HTMLInputElement;
    const until = screen.getByLabelText("Committed before") as HTMLInputElement;

    fireEvent.keyDown(since, { key: "Tab", shiftKey: true });
    expect(since.value).toBe(""); // backing out never fills

    fireEvent.keyDown(since, { key: "Tab" });
    expect(since.value).toBe(hints.since);
    expect(
      screen.getByRole("button", { name: `Remove After ${hints.since} filter` }),
    ).toBeInTheDocument();

    fireEvent.change(until, { target: { value: "20200101" } });
    fireEvent.keyDown(until, { key: "Tab" });
    expect(until.value).toBe("2020-01-01"); // a typed value is never overwritten
  });

  it("masks typed digits into YYYY-MM-DD", () => {
    render(<AdvancedHistorySearch />);
    const since = screen.getByLabelText("Committed after") as HTMLInputElement;
    fireEvent.change(since, { target: { value: "20250715" } });
    expect(since.value).toBe("2025-07-15");
    expect(screen.getByRole("button", { name: "Remove After 2025-07-15 filter" })).toBeInTheDocument();
  });

  it("holds the invalid flag while typing and raises it on blur", () => {
    render(<AdvancedHistorySearch />);
    const since = screen.getByLabelText("Committed after") as HTMLInputElement;
    fireEvent.focus(since);
    fireEvent.change(since, { target: { value: "22" } });

    // Mid-edit: no nagging, but the search is already (quietly) blocked.
    expect(since).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText(/Dates must be/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search repository" })).toBeDisabled();

    fireEvent.blur(since);
    expect(since).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Dates must be/)).toBeInTheDocument();
  });

  it("hints the date range with placeholders (-1y / today) without activating a filter", () => {
    render(<AdvancedHistorySearch />);
    const hints = datePlaceholders();
    const since = screen.getByLabelText("Committed after") as HTMLInputElement;
    const until = screen.getByLabelText("Committed before") as HTMLInputElement;
    expect(since.value).toBe("");
    expect(until.value).toBe("");
    expect(since.placeholder).toBe(hints.since);
    expect(until.placeholder).toBe(hints.until);
    // Placeholders are hints, not filters — no chips, no Clear all.
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

  it("explains how to narrow a work-bounded partial result", async () => {
    useRepo.setState({
      summary: summaryFor("/a"),
      searchHistory: async () => ({ ...pageWith("c1"), truncated: true, workTruncated: true }),
    });
    render(<AdvancedHistorySearch />);
    runSearch();

    expect(
      await screen.findByText("Showing partial results — narrow the revision or date range."),
    ).toBeInTheDocument();
  });

  it("keeps the result-cap message when the work budget was not exhausted", async () => {
    useRepo.setState({
      summary: summaryFor("/a"),
      searchHistory: async () => ({ ...pageWith("c1"), truncated: true }),
    });
    render(<AdvancedHistorySearch />);
    runSearch();

    expect(await screen.findByText("Showing the first 200 matches.")).toBeInTheDocument();
  });

  it("describes an empty work-bounded search as a partial scan", async () => {
    useRepo.setState({
      summary: summaryFor("/a"),
      searchHistory: async () => ({ results: [], truncated: true, workTruncated: true }),
    });
    render(<AdvancedHistorySearch />);
    runSearch();

    expect(await screen.findByText("No matches in the scanned history.")).toBeInTheDocument();
    expect(screen.queryByText("No matching commits.")).not.toBeInTheDocument();
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
