import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileHistoryEntry } from "../../lib/api";
import type { FileHistoryState } from "../../store/repoTypes";
import { useRepo } from "../../store/repo";
import { FileHistoryView } from "./file-history";

// View-state tests (GL-193): the file-history mode's visible branches, seeded
// straight into the repo store — locked against the monolithic
// FileHistoryView.tsx before the folder split, kept green after it.

const entry = (over: Partial<FileHistoryEntry> = {}): FileHistoryEntry => ({
  oid: "aaaa111",
  shortOid: "aaaa111",
  subject: "feat: change the file",
  body: "",
  authorName: "Ada",
  authorEmail: "ada@example.test",
  timestamp: 1,
  status: "M",
  path: "src/app.ts",
  add: 3,
  del: 1,
  previousPath: null,
  ...over,
});

const historyState = (over: Partial<FileHistoryState> = {}): FileHistoryState => ({
  path: "src/app.ts",
  mode: "history",
  entries: [],
  loading: false,
  loadingMore: false,
  error: null,
  hasMore: false,
  nextOffset: 0,
  truncated: false,
  selectedOid: null,
  selectedPath: null,
  selectedDiff: null,
  diffLoading: false,
  blame: null,
  blameLoading: false,
  blameError: null,
  blameRevision: null,
  blameSelectedOid: null,
  ...over,
});

const realSelectRevision = useRepo.getState().selectFileHistoryRevision;
const realLoadMore = useRepo.getState().loadMoreFileHistory;
const realOpenFileHistory = useRepo.getState().openFileHistory;
const realRevealCommit = useRepo.getState().revealCommit;

beforeEach(() => {
  useRepo.setState({
    fileHistory: null,
    selectFileHistoryRevision: realSelectRevision,
    loadMoreFileHistory: realLoadMore,
    openFileHistory: realOpenFileHistory,
    revealCommit: realRevealCommit,
  });
});

const noop = () => {};

describe("FileHistoryView states", () => {
  it("renders nothing without an open file history", () => {
    const { container } = render(<FileHistoryView onBlameRevision={noop} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the loading skeleton and hides the revision count while loading", () => {
    useRepo.setState({ fileHistory: historyState({ loading: true }) });
    const { container } = render(<FileHistoryView onBlameRevision={noop} />);
    expect(container.querySelectorAll(".shim").length).toBeGreaterThan(0);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("shows the error state with a retry that reloads the same path", () => {
    const openFileHistory = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      fileHistory: historyState({ error: "fatal: bad object" }),
      openFileHistory,
    });
    render(<FileHistoryView onBlameRevision={noop} />);

    expect(screen.getByText("Couldn't load history")).toBeInTheDocument();
    // The message shows in the revision list's error card AND the diff pane.
    expect(screen.getAllByText("fatal: bad object")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(openFileHistory).toHaveBeenCalledWith("src/app.ts");
  });

  it("keeps the entries list when an error arrives after a successful load", () => {
    // The full-page error state is only for an empty list — a later failure
    // (e.g. a diff fetch) must not blank the loaded history.
    useRepo.setState({
      fileHistory: historyState({ error: "boom", entries: [entry()] }),
    });
    render(<FileHistoryView onBlameRevision={noop} />);
    expect(screen.queryByText("Couldn't load history")).not.toBeInTheDocument();
    expect(screen.getByText("feat: change the file")).toBeInTheDocument();
  });

  it("shows the empty state when no commits touch the path", () => {
    useRepo.setState({ fileHistory: historyState() });
    render(<FileHistoryView onBlameRevision={noop} />);
    expect(screen.getByText("No commits changed this path.")).toBeInTheDocument();
  });

  it("counts revisions in the header, with a trailing + when truncated", () => {
    useRepo.setState({
      fileHistory: historyState({ entries: [entry(), entry({ oid: "bbbb222", shortOid: "bbbb222" })], truncated: true }),
    });
    render(<FileHistoryView onBlameRevision={noop} />);
    expect(screen.getByText("2+")).toBeInTheDocument();
  });

  it("banners a deletion and marks renamed revisions", () => {
    useRepo.setState({
      fileHistory: historyState({
        entries: [
          entry({ oid: "dead111", shortOid: "dead111", status: "D" }),
          entry({ oid: "ren2222", shortOid: "ren2222", status: "R", previousPath: "src/old.ts" }),
        ],
      }),
    });
    render(<FileHistoryView onBlameRevision={noop} />);

    expect(screen.getByText(/history shown up to deletion/)).toBeInTheDocument();
    expect(screen.getByText("renamed from src/old.ts")).toBeInTheDocument();
  });

  it("selects a revision on row click", () => {
    const selectFileHistoryRevision = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      fileHistory: historyState({ entries: [entry()] }),
      selectFileHistoryRevision,
    });
    render(<FileHistoryView onBlameRevision={noop} />);

    fireEvent.click(screen.getByText("feat: change the file"));
    expect(selectFileHistoryRevision).toHaveBeenCalledWith("aaaa111", "src/app.ts");
  });

  it("loads more revisions and shows the in-flight label", () => {
    const loadMoreFileHistory = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      fileHistory: historyState({ entries: [entry()], hasMore: true }),
      loadMoreFileHistory,
    });
    const { rerender } = render(<FileHistoryView onBlameRevision={noop} />);

    fireEvent.click(screen.getByRole("button", { name: "Load more · showing 1" }));
    expect(loadMoreFileHistory).toHaveBeenCalledTimes(1);

    useRepo.setState({
      fileHistory: historyState({ entries: [entry()], hasMore: true, loadingMore: true }),
    });
    rerender(<FileHistoryView onBlameRevision={noop} />);
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
  });
});

describe("FileHistoryView selected revision", () => {
  const selectedState = () =>
    historyState({
      entries: [entry()],
      selectedOid: "aaaa111",
      selectedPath: "src/app.ts",
    });

  it("shows the header stats, inspector card, and both blame entry points", () => {
    const onBlameRevision = vi.fn();
    const revealCommit = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ fileHistory: selectedState(), revealCommit });
    render(<FileHistoryView onBlameRevision={onBlameRevision} />);

    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(screen.getByText("at aaaa111")).toBeInTheDocument();
    expect(screen.getAllByText("+3")).not.toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Open this commit" }));
    expect(revealCommit).toHaveBeenCalledWith("aaaa111");

    // Header button and inspector action both blame at the selected revision.
    for (const btn of screen.getAllByRole("button", { name: "Blame at this revision" })) {
      fireEvent.click(btn);
    }
    expect(onBlameRevision).toHaveBeenCalledTimes(2);
    expect(onBlameRevision).toHaveBeenCalledWith("aaaa111", "src/app.ts");
  });

  it("copies the full SHA from the inspector", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    useRepo.setState({ fileHistory: selectedState() });
    render(<FileHistoryView onBlameRevision={noop} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy SHA" }));
    expect(writeText).toHaveBeenCalledWith("aaaa111");
  });

  it("re-fetches the uncapped diff from the truncated notice", () => {
    const selectFileHistoryRevision = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      fileHistory: {
        ...selectedState(),
        selectedDiff: {
          path: "src/app.ts",
          status: "M",
          add: 3,
          del: 1,
          binary: false,
          hunks: [],
          truncated: true,
        },
      },
      selectFileHistoryRevision,
    });
    render(<FileHistoryView onBlameRevision={noop} />);

    fireEvent.click(screen.getByRole("button", { name: "Show full diff" }));
    expect(selectFileHistoryRevision).toHaveBeenCalledWith("aaaa111", "src/app.ts", true);
  });
});
