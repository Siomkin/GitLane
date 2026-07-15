import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileChange, FileDiff } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useUi } from "@/store/ui";
import { StackedReview } from "./StackedReview";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// jsdom has no layout engine, so `scrollIntoView` is undefined. StackedReview
// calls it in an effect when a committed file is selected (to bring that file's
// section into view), so stub it to keep that path from throwing.
Element.prototype.scrollIntoView = vi.fn();

const file = (path: string, add: number, del: number): FileChange => ({
  path,
  status: "M",
  add,
  del,
  binary: false,
});

const diffFor = (path: string): FileDiff => ({
  path,
  status: "M",
  add: 1,
  del: 0,
  binary: false,
  truncated: false,
  hunks: [
    {
      header: "@@ -1 +1 @@",
      lines: [{ kind: "add", oldNo: null, newNo: 1, content: `diff of ${path}` }],
    },
  ],
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
    if (command === "commit_files") {
      // A small source file plus a lockfile-sized generated file.
      return Promise.resolve([file("src/small.ts", 10, 2), file("bun.lock", 5_000, 4_000)]);
    }
    if (command === "commit_file_diff") {
      return Promise.resolve(diffFor(args.file as string));
    }
    return Promise.resolve([]);
  });
  useRepo.setState({
    summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
    selectedFile: null,
  });
  useTerminalAgents.setState({
    agents: [],
    loading: false,
    error: null,
    loadAgents: vi.fn(async () => {}),
  });
  useUi.setState({
    stackedReview: { oid: "c1", range: undefined, title: "Reviewing c1" },
    reviewNotes: [],
  });
});

describe("StackedReview — progressive load + collapse", () => {
  it("streams small files and starts large/generated files collapsed", async () => {
    // Syntax highlighting splits diff content across token <span>s, so assert on
    // the rejoined textContent rather than a single matching text node.
    const { container } = render(<StackedReview />);

    // The small file's diff streams into its section without waiting for the
    // whole list to resolve (progressive load, not all-or-nothing).
    await waitFor(() =>
      expect(container.textContent).toContain("diff of src/small.ts"),
    );

    // The lockfile section exists but starts collapsed: its body is not rendered
    // and — crucially — its diff was never fetched.
    expect(screen.getByText("bun.lock")).toBeInTheDocument();
    expect(container.textContent).not.toContain("diff of bun.lock");
    expect(invokeMock).not.toHaveBeenCalledWith("commit_file_diff", {
      path: "/r",
      oid: "c1",
      file: "bun.lock",
      full: false,
    });

    // Expanding it lazily fetches and renders the diff on demand.
    fireEvent.click(screen.getByText("bun.lock"));
    await waitFor(() => expect(container.textContent).toContain("diff of bun.lock"));
    expect(invokeMock).toHaveBeenCalledWith("commit_file_diff", {
      path: "/r",
      oid: "c1",
      file: "bun.lock",
      full: false,
    });
  });

  it("offers an AI description for an already committed review", async () => {
    const sendToTerminal = vi.fn();
    useTerminalAgents.setState({
      agents: [{ id: "codex", name: "codex", command: "codex", description: "", enabled: true, available: true }],
    });
    useUi.setState({ sendToTerminal });
    useRepo.setState({
      takeAgentChangeSummary: vi.fn(async () =>
        "Introduces the committed behavior and updates its supporting tests.",
      ),
    });

    render(<StackedReview />);
    await screen.findByText("Explain what these changes do");
    fireEvent.click(screen.getByRole("button", { name: "Describe changes with agent" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "codex" }));

    expect(sendToTerminal).toHaveBeenCalledWith(
      expect.stringContaining("Review commit or stash c1"),
      "codex",
    );
    expect(
      await screen.findByText(
        "Introduces the committed behavior and updates its supporting tests.",
      ),
    ).toBeVisible();
  });

  it("offers 'show full diff' on a truncated diff and re-fetches uncapped", async () => {
    const diffWith = (marker: string, truncated: boolean): FileDiff => ({
      path: "src/big.ts",
      status: "M",
      add: 1,
      del: 0,
      binary: false,
      truncated,
      hunks: [
        { header: "@@ -1 +1 @@", lines: [{ kind: "add", oldNo: null, newNo: 1, content: marker }] },
      ],
    });
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "commit_files") return Promise.resolve([file("src/big.ts", 100, 0)]);
      if (command === "commit_file_diff") {
        return Promise.resolve(
          args.full ? diffWith("FULLDIFFMARKER", false) : diffWith("CAPPEDDIFFMARKER", true),
        );
      }
      return Promise.resolve([]);
    });

    const { container } = render(<StackedReview />);

    // The (small, open) file streams in capped, with the truncation notice.
    await waitFor(() => expect(container.textContent).toContain("CAPPEDDIFFMARKER"));
    const showFull = screen.getByRole("button", { name: "Show full diff" });

    // Showing full re-keys the fetch (path:full) to bypass the cap and renders it.
    fireEvent.click(showFull);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_file_diff", {
        path: "/r",
        oid: "c1",
        file: "src/big.ts",
        full: true,
      }),
    );
    await waitFor(() => expect(container.textContent).toContain("FULLDIFFMARKER"));
  });
});

describe("StackedReview — back to graph", () => {
  it("clears the open file so 'Graph' returns to the graph, not the single-file review", async () => {
    // Reproduce the reported flow: a committed file was open (single-file
    // review) before "review all". The center-pane dispatcher checks
    // `stackedReview` before `selectedFile`, so closing the stacked review
    // alone would resurface the single-file review instead of the graph.
    useRepo.setState({ selectedFile: { path: "src/small.ts", source: "commit" } });

    render(<StackedReview />);
    await screen.findByText("small.ts");

    fireEvent.click(screen.getByRole("button", { name: /graph/i }));

    // Both must be cleared so the dispatcher falls through to the graph.
    expect(useUi.getState().stackedReview).toBeNull();
    expect(useRepo.getState().selectedFile).toBeNull();
  });
});
