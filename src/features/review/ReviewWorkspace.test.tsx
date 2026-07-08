import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffLine, FileDiff } from "../../lib/api";
import { useRepo } from "../../store/repo";
import { ReviewWorkspace } from "./ReviewWorkspace";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// jsdom has no layout, so feed TanStack Virtual a viewport (the scroll element)
// and a measured height per row; otherwise the window degenerates to 0-height
// rows and the assertion is meaningless.
beforeAll(() => {
  const isScroll = (el: HTMLElement) =>
    el.getAttribute("data-testid") === "review-unified-scroll" ||
    el.getAttribute("data-testid") === "review-split-scroll";
  const rect = (height: number): DOMRect =>
    ({
      height,
      width: 600,
      top: 0,
      left: 0,
      right: 600,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return isScroll(this) ? 400 : 19;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 600;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (this.hasAttribute("data-index")) return rect(19);
      if (isScroll(this)) return rect(400);
      return rect(0);
    },
  });
});

const bigDiff = (lines: number): FileDiff => ({
  path: "src/huge.ts",
  status: "M",
  add: lines,
  del: 0,
  binary: false,
  truncated: false,
  hunks: [
    {
      header: "@@ -1 +1 @@",
      lines: Array.from(
        { length: lines },
        (_, i): DiffLine => ({ kind: "add", oldNo: null, newNo: i + 1, content: `line ${i}` }),
      ),
    },
  ],
});

beforeEach(() => {
  useRepo.setState({ fileDiff: bigDiff(4_000), diffLoading: false });
});

describe("ReviewWorkspace — virtualized diff", () => {
  it("mounts only a bounded window of rows for a large diff", () => {
    const { container } = render(<ReviewWorkspace />);
    const mounted = container.querySelectorAll("[data-index]").length;
    expect(mounted).toBeGreaterThan(0);
    // A 400px viewport over 19px rows fits ~21 rows; with overscan the window
    // stays far below the 4,000 changed lines.
    expect(mounted).toBeLessThan(200);
  });

  it("offers 'show full diff' on a truncated diff and re-fetches uncapped", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ ...bigDiff(30), truncated: false });
    useRepo.setState({
      summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
      selectedCommit: "c1",
      selectedFile: { path: "src/huge.ts", source: "commit" },
      fileDiff: { ...bigDiff(30), truncated: true },
      diffLoading: false,
    });

    render(<ReviewWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Show full diff" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_file_diff", {
        path: "/r",
        oid: "c1",
        file: "src/huge.ts",
        full: true,
      }),
    );
    await waitFor(() => expect(useRepo.getState().fileDiff?.truncated).toBe(false));
  });

  it("stages a working diff hunk through the repo store action", () => {
    const applyHunk = vi.fn(async () => {});
    useRepo.setState({
      summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
      selectedFile: { path: "src/huge.ts", source: "unstaged" },
      fileDiff: bigDiff(3),
      diffLoading: false,
      applyHunk,
    });

    render(<ReviewWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Stage hunk" }));

    expect(applyHunk).toHaveBeenCalledWith(
      "src/huge.ts",
      false,
      0,
      "@@ -1 +1 @@",
      "+line 0\n+line 1\n+line 2",
    );
  });

  it("does not expose patch staging for guarded advanced files", () => {
    const applyHunk = vi.fn(async () => {});
    const applyLine = vi.fn(async () => {});
    useRepo.setState({
      summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
      selectedFile: { path: "docs/hidden.txt", source: "unstaged" },
      fileDiff: { ...bigDiff(3), path: "docs/hidden.txt" },
      diffLoading: false,
      changes: {
        staged: [],
        unstaged: [{ path: "docs/hidden.txt", status: "M", add: 3, del: 0, binary: false }],
        conflicted: [],
        advanced: {
          submodules: [],
          lfs: { detected: false, installed: null, issues: [], patterns: [] },
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["/*", "!/*/", "/src/"] },
        },
      },
      applyHunk,
      applyLine,
    });

    render(<ReviewWorkspace />);

    expect(screen.queryByRole("button", { name: "Stage hunk" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stage line" })).not.toBeInTheDocument();
  });

  it("stages a changed line through the repo store action", () => {
    const applyLine = vi.fn(async () => {});
    const fileDiff = bigDiff(3);
    useRepo.setState({
      summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
      selectedFile: { path: "src/huge.ts", source: "unstaged" },
      fileDiff,
      diffLoading: false,
      applyLine,
    });

    render(<ReviewWorkspace />);
    fireEvent.click(screen.getAllByRole("button", { name: "Stage line" })[0]);

    expect(applyLine).toHaveBeenCalledWith("src/huge.ts", false, 0, 0, fileDiff.hunks[0].lines[0]);
  });

  it("unstages a changed line from a staged diff through the repo store action", () => {
    const applyLine = vi.fn(async () => {});
    const fileDiff = bigDiff(3);
    useRepo.setState({
      summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
      selectedFile: { path: "src/huge.ts", source: "staged" },
      fileDiff,
      diffLoading: false,
      applyLine,
    });

    render(<ReviewWorkspace />);
    fireEvent.click(screen.getAllByRole("button", { name: "Unstage line" })[0]);

    expect(applyLine).toHaveBeenCalledWith("src/huge.ts", true, 0, 0, fileDiff.hunks[0].lines[0]);
  });

  it("hides the Unified/Split toggle and shows the binary card for a binary file", () => {
    useRepo.setState({
      fileDiff: { path: "docs/spec.pdf", status: "A", add: 0, del: 0, binary: true, truncated: false, hunks: [] },
      diffLoading: false,
    });
    render(<ReviewWorkspace />);
    // The toggle is meaningless for a binary file (renders a card, not hunks).
    expect(screen.queryByRole("button", { name: "Unified" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Split" })).not.toBeInTheDocument();
    expect(screen.getByText("PDF document")).toBeInTheDocument();
  });

  it("offers Code/Preview only for markdown files and renders the blob as markdown", async () => {
    const source = "# Hello\n\nSome **body** text.";
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({
      base64: btoa(String.fromCharCode(...new TextEncoder().encode(source))),
      size: source.length,
      truncated: false,
    });
    useRepo.setState({
      summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
      selectedCommit: "c1",
      selectedFile: { path: "docs/guide.md", source: "commit" },
      fileDiff: { ...bigDiff(3), path: "docs/guide.md", newOid: "beef" },
      diffLoading: false,
    });

    render(<ReviewWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    // Committed diff reads the new-side blob by oid; the raw-diff layout toggle
    // hides while the rendered preview replaces the diff.
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "read_binary_blob",
        expect.objectContaining({ path: "/r", oid: "beef", file: null }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Unified" })).not.toBeInTheDocument();

    // Back to Code: the diff rows return, the preview goes away.
    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(screen.queryByRole("heading", { name: "Hello" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unified" })).toBeInTheDocument();
  });

  it("reads the working tree by path when previewing an unstaged markdown diff", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ base64: btoa("# WT"), size: 4, truncated: false });
    useRepo.setState({
      summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
      selectedFile: { path: "README.md", source: "unstaged" },
      // Even with a reported oid, the worktree side must be read from disk —
      // libgit2's computed hash need not exist in the ODB.
      fileDiff: { ...bigDiff(3), path: "README.md", newOid: "cafe" },
      diffLoading: false,
    });

    render(<ReviewWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "read_binary_blob",
        expect.objectContaining({ path: "/r", oid: null, file: "README.md" }),
      ),
    );
    await waitFor(() => expect(screen.getByRole("heading", { name: "WT" })).toBeInTheDocument());
  });

  it("hides the Code/Preview toggle for non-markdown files", () => {
    useRepo.setState({ fileDiff: bigDiff(3), diffLoading: false });
    render(<ReviewWorkspace />);
    expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Code" })).not.toBeInTheDocument();
  });

  it("stages a changed line from split view", () => {
    const applyLine = vi.fn(async () => {});
    const fileDiff = bigDiff(3);
    useRepo.setState({
      summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
      selectedFile: { path: "src/huge.ts", source: "unstaged" },
      fileDiff,
      diffLoading: false,
      applyLine,
    });

    render(<ReviewWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Stage line" })[0]);

    expect(applyLine).toHaveBeenCalledWith("src/huge.ts", false, 0, 0, fileDiff.hunks[0].lines[0]);
  });

  it("unstages a changed line from split view", () => {
    const applyLine = vi.fn(async () => {});
    const fileDiff = bigDiff(3);
    useRepo.setState({
      summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
      selectedFile: { path: "src/huge.ts", source: "staged" },
      fileDiff,
      diffLoading: false,
      applyLine,
    });

    render(<ReviewWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Unstage line" })[0]);

    expect(applyLine).toHaveBeenCalledWith("src/huge.ts", true, 0, 0, fileDiff.hunks[0].lines[0]);
  });
});
