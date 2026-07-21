import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommitNode, HistorySearchPage, RepoGraph } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { AdvancedHistorySearch } from "./index";
import { datePlaceholders } from "./advancedSearchModel";

const realActions = {
  searchHistory: useRepo.getState().searchHistory,
  suggestTreePaths: useRepo.getState().suggestTreePaths,
  revealCommit: useRepo.getState().revealCommit,
  loadMoreHistory: useRepo.getState().loadMoreHistory,
  graphLimit: useRepo.getState().graphLimit,
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
  vi.useRealTimers();
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

  it("synchronously masks the old query and results when the repository switches", async () => {
    useRepo.setState({ summary: summaryFor("/a"), searchHistory: async () => pageWith("c1") });
    render(<AdvancedHistorySearch />);
    runSearch();
    await screen.findByText("commit c1");
    const regexMode = screen.getAllByRole("radio")[1];
    fireEvent.click(regexMode);

    // Switch repos — the controller adjusts its repo-owned session before the
    // next children commit, without waiting on an effect or an explicit rerender.
    act(() => useRepo.setState({ summary: summaryFor("/b") }));
    expect(messageInput().value).toBe("");
    expect(screen.queryByText("commit c1")).not.toBeInTheDocument();
    // Match mode was deliberately outside the old reset and remains local.
    expect(screen.getAllByRole("radio")[1]).toHaveAttribute("aria-checked", "true");
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

  it("leaves the search button idle after a repo switch strands the old request", async () => {
    // The repo-A request never settles this session's loading flag once its
    // generation is invalidated, so the reset itself must clear the spinner —
    // otherwise the panel is stuck on "Searching…" with no way back.
    useRepo.setState({
      summary: summaryFor("/a"),
      searchHistory: () => new Promise<HistorySearchPage>(() => {}),
    });
    const { rerender } = render(<AdvancedHistorySearch />);
    runSearch();
    expect(screen.getByRole("button", { name: "Searching…" })).toBeDisabled();

    act(() => useRepo.setState({ summary: summaryFor("/b") }));
    rerender(<AdvancedHistorySearch />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Search repository" })).toBeEnabled(),
    );
  });

  it("stops reveal paging as soon as the repository underneath it changes", async () => {
    // Reveal pages the graph in a loop; a switch mid-loop must abort it rather
    // than hunting the old repo's commit id through the new repo's history.
    const loadMoreHistory = vi.fn(async () => {
      act(() => useRepo.setState({ summary: summaryFor("/b") }));
    });
    useRepo.setState({
      summary: summaryFor("/a"),
      searchHistory: async () => pageWith("c1"),
      graph: { ...graphWith([]), truncated: true },
      loadMoreHistory,
    });
    render(<AdvancedHistorySearch />);
    runSearch();

    fireEvent.click(await screen.findByText("commit c1"));

    await waitFor(() => expect(loadMoreHistory).toHaveBeenCalledTimes(1));
    // One page ran before the switch landed; the loop must not page again, and
    // must not surface its "outside the loaded ref set" error for the old repo.
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(loadMoreHistory).toHaveBeenCalledTimes(1);
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

  it("debounces path suggestions for 200ms and preserves input focus when they land", async () => {
    vi.useFakeTimers();
    const suggestTreePaths = vi.fn(async () => ["src/store/repo.ts"]);
    useRepo.setState({ summary: summaryFor("/a"), suggestTreePaths });
    render(<AdvancedHistorySearch />);
    const path = screen.getByPlaceholderText("src/store") as HTMLInputElement;
    path.focus();
    fireEvent.change(path, { target: { value: "repo" } });

    await act(async () => vi.advanceTimersByTimeAsync(199));
    expect(suggestTreePaths).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));

    expect(suggestTreePaths).toHaveBeenCalledOnce();
    expect(suggestTreePaths).toHaveBeenCalledWith("repo");
    expect(screen.getByRole("option", { name: "src/store/repo.ts" })).toBeInTheDocument();
    expect(document.activeElement).toBe(path);
  });

  it("drops an in-flight path suggestion after a repository switch", async () => {
    vi.useFakeTimers();
    let resolvePaths: (paths: string[]) => void = () => {};
    const pending = new Promise<string[]>((resolve) => (resolvePaths = resolve));
    const suggestTreePaths = vi.fn(() => pending);
    useRepo.setState({ summary: summaryFor("/a"), suggestTreePaths });
    render(<AdvancedHistorySearch />);
    const path = screen.getByPlaceholderText("src/store") as HTMLInputElement;
    fireEvent.focus(path);
    fireEvent.change(path, { target: { value: "old" } });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(suggestTreePaths).toHaveBeenCalledWith("old");

    act(() => useRepo.setState({ summary: summaryFor("/b") }));
    expect((screen.getByPlaceholderText("src/store") as HTMLInputElement).value).toBe("");
    await act(async () => resolvePaths(["old/repo/path.ts"]));

    expect(screen.queryByRole("option", { name: "old/repo/path.ts" })).not.toBeInTheDocument();
  });

  it("clears already-visible path suggestions synchronously on repository switch", async () => {
    vi.useFakeTimers();
    const suggestTreePaths = vi.fn(async () => ["repo-a/path.ts"]);
    useRepo.setState({ summary: summaryFor("/a"), suggestTreePaths });
    render(<AdvancedHistorySearch />);
    const path = screen.getByPlaceholderText("src/store") as HTMLInputElement;
    fireEvent.focus(path);
    fireEvent.change(path, { target: { value: "repo-a" } });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(screen.getByRole("option", { name: "repo-a/path.ts" })).toBeInTheDocument();

    act(() => useRepo.setState({ summary: summaryFor("/b") }));

    expect(path.value).toBe("");
    expect(screen.queryByRole("option", { name: "repo-a/path.ts" })).not.toBeInTheDocument();
  });

  it("keeps newer path suggestions when an older request resolves last", async () => {
    vi.useFakeTimers();
    let resolveOld: (paths: string[]) => void = () => {};
    let resolveNew: (paths: string[]) => void = () => {};
    const oldPending = new Promise<string[]>((resolve) => (resolveOld = resolve));
    const newPending = new Promise<string[]>((resolve) => (resolveNew = resolve));
    const suggestTreePaths = vi.fn((filter: string) =>
      filter === "old" ? oldPending : newPending,
    );
    useRepo.setState({ summary: summaryFor("/a"), suggestTreePaths });
    render(<AdvancedHistorySearch />);
    const path = screen.getByPlaceholderText("src/store") as HTMLInputElement;
    fireEvent.focus(path);

    fireEvent.change(path, { target: { value: "old" } });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    fireEvent.change(path, { target: { value: "new" } });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(suggestTreePaths.mock.calls).toEqual([["old"], ["new"]]);

    await act(async () => resolveNew(["new/path.ts"]));
    expect(screen.getByRole("option", { name: "new/path.ts" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "old/path.ts" })).not.toBeInTheDocument();

    await act(async () => resolveOld(["old/path.ts"]));
    expect(screen.getByRole("option", { name: "new/path.ts" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "old/path.ts" })).not.toBeInTheDocument();
  });

  it("pages with live repo state until the selected search hit can be revealed", async () => {
    const revealCommit = vi.fn(async () => {});
    const loadMoreHistory = vi.fn(async () => {
      useRepo.setState({
        graph: graphWith(["target"]),
        graphLimit: 4_000,
      });
    });
    useRepo.setState({
      summary: summaryFor("/a"),
      searchHistory: async () => pageWith("target"),
      graph: { ...graphWith(["c1"]), truncated: true },
      graphLimit: 2_000,
      loadMoreHistory,
      revealCommit,
    });
    render(<AdvancedHistorySearch />);
    runSearch();
    await screen.findByText("commit target");

    fireEvent.click(resultButton("commit target"));
    await waitFor(() => expect(revealCommit).toHaveBeenCalledWith("target"));
    expect(loadMoreHistory).toHaveBeenCalledOnce();
  });

  it("stops reveal paging when a page makes no graph-limit progress", async () => {
    const revealCommit = vi.fn(async () => {});
    const loadMoreHistory = vi.fn(async () => {});
    useRepo.setState({
      summary: summaryFor("/a"),
      searchHistory: async () => pageWith("target"),
      graph: { ...graphWith(["c1"]), truncated: true },
      graphLimit: 2_000,
      loadMoreHistory,
      revealCommit,
    });
    render(<AdvancedHistorySearch />);
    runSearch();
    await screen.findByText("commit target");

    fireEvent.click(resultButton("commit target"));
    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("The commit is reachable in search but outside the graph's loaded ref set.");
    expect(loadMoreHistory).toHaveBeenCalledOnce();
    expect(revealCommit).not.toHaveBeenCalled();
  });

  it("caps a progressing reveal at 50 history pages", async () => {
    const revealCommit = vi.fn(async () => {});
    const loadMoreHistory = vi.fn(async () => {
      useRepo.setState((state) => ({ graphLimit: state.graphLimit + 1 }));
    });
    useRepo.setState({
      summary: summaryFor("/a"),
      searchHistory: async () => pageWith("target"),
      graph: { ...graphWith(["c1"]), truncated: true },
      graphLimit: 2_000,
      loadMoreHistory,
      revealCommit,
    });
    render(<AdvancedHistorySearch />);
    runSearch();
    await screen.findByText("commit target");

    fireEvent.click(resultButton("commit target"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(loadMoreHistory).toHaveBeenCalledTimes(50);
    expect(revealCommit).not.toHaveBeenCalled();
  });
});
