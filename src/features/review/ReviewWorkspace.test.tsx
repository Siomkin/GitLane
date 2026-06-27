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
});
