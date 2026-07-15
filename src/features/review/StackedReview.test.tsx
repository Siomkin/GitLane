import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileChange, FileDiff } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useUi } from "@/store/ui";
import { MAX_CACHED_STACKED_DIFFS, StackedReview } from "./StackedReview";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight",
);
const offsetWidthDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth",
);
const rectDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "getBoundingClientRect",
);
const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollHeight",
);
const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");

// jsdom has no layout engine. Give the stacked virtualizer a real viewport and
// measurable rows so tests exercise the same bounded window as the app.
beforeAll(() => {
  const rect = (height: number): DOMRect =>
    ({
      height,
      width: 800,
      top: 0,
      left: 0,
      right: 800,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.getAttribute("data-testid") === "stacked-review-scroll" ? 400 : 22;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 800;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      return rect(this.getAttribute("data-testid") === "stacked-review-scroll" ? 400 : 22);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (this.getAttribute("data-testid") !== "stacked-review-scroll") return 0;
      return Number.parseFloat((this.lastElementChild as HTMLElement | null)?.style.height ?? "0");
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: function scrollTo(options?: ScrollToOptions | number, y?: number) {
      this.scrollTop =
        typeof options === "number" ? (y ?? 0) : (options?.top ?? this.scrollTop);
      this.dispatchEvent(new Event("scroll"));
      this.dispatchEvent(new Event("scrollend"));
    },
  });
});

// A scroll leaves TanStack's scroll observer holding a ~150ms debounce timer
// (it uses the fallback timer, not the native scrollend event, and does not
// cancel it on unmount). If that timer fires after Vitest tears down this
// file's jsdom environment it throws `window is not defined` from React,
// failing the run as an unhandled error even though every test passed. Flush it
// inside act() while the environment still exists so nothing survives teardown.
afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
});

afterAll(() => {
  for (const [property, descriptor] of [
    ["offsetHeight", offsetHeightDescriptor],
    ["offsetWidth", offsetWidthDescriptor],
    ["getBoundingClientRect", rectDescriptor],
    ["scrollHeight", scrollHeightDescriptor],
    ["scrollTo", scrollToDescriptor],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, property, descriptor);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, property);
    }
  }
});

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

const diffWithLines = (path: string, count: number): FileDiff => ({
  ...diffFor(path),
  add: count,
  hunks: [
    {
      header: `@@ -1 +1,${count} @@`,
      lines: Array.from({ length: count }, (_, index) => ({
        kind: "add" as const,
        oldNo: null,
        newNo: index + 1,
        content: `${path} line ${index + 1}`,
      })),
    },
  ],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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
    fileSelectionRequestId: 0,
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
  it("bounds mounted rows and fetches only files in the virtual window", async () => {
    // 200 files × 250 changed lines represents the ticket's 50k-line fixture.
    const manyFiles = Array.from({ length: 200 }, (_, index) =>
      file(`src/file-${index}.ts`, 250, 0),
    );
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "commit_files") return Promise.resolve(manyFiles);
      if (command === "commit_file_diff") {
        return Promise.resolve(diffWithLines(args.file as string, 250));
      }
      return Promise.resolve([]);
    });

    const { container } = render(<StackedReview />);
    await screen.findByText("file-0.ts");
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "commit_file_diff").length,
      ).toBeGreaterThan(0),
    );

    const fetches = invokeMock.mock.calls.filter(([command]) => command === "commit_file_diff");
    expect(fetches.length).toBeLessThan(100);
    expect(container.querySelectorAll("[data-index]").length).toBeLessThan(100);
    expect(screen.queryByText("file-199.ts")).not.toBeInTheDocument();
    expect(container.querySelector("[data-file-path]")?.className).not.toContain(
      "backdrop-blur",
    );

    const scroll = screen.getByTestId("stacked-review-scroll");
    act(() => {
      scroll.scrollTop = 200;
      scroll.dispatchEvent(new Event("scroll"));
    });
    const breadcrumb = await screen.findByTestId("stacked-file-breadcrumb");
    expect(breadcrumb).toHaveTextContent("src/file-0.ts");
    expect(breadcrumb.className).not.toContain("backdrop-blur");

    // The breadcrumb stands in for the old sticky header: clicking it collapses
    // the file the reviewer is inside and lands back on its header row.
    fireEvent.click(breadcrumb);
    await waitFor(() =>
      expect(container.querySelector('[data-file-path="src/file-0.ts"]')).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
    expect(container.textContent).not.toContain("src/file-0.ts line 1");
  });

  it("keeps a delivered AI description alive while scrolled deep into the review", async () => {
    const manyFiles = Array.from({ length: 200 }, (_, index) =>
      file(`src/file-${index}.ts`, 1, 0),
    );
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "commit_files") return Promise.resolve(manyFiles);
      if (command === "commit_file_diff") return Promise.resolve(diffFor(args.file as string));
      return Promise.resolve([]);
    });
    useTerminalAgents.setState({
      agents: [{ id: "codex", name: "codex", command: "codex", description: "", enabled: true, available: true }],
    });
    useUi.setState({ sendToTerminal: vi.fn() });
    useRepo.setState({
      takeAgentChangeSummary: vi.fn(async () => "Summarizes the reviewed change."),
    });

    render(<StackedReview />);
    await screen.findByText("Explain what these changes do");
    fireEvent.click(screen.getByRole("button", { name: "Describe changes with agent" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "codex" }));
    expect(await screen.findByText("Summarizes the reviewed change.")).toBeInTheDocument();

    const scroll = screen.getByTestId("stacked-review-scroll");
    act(() => {
      scroll.scrollTop = 4_000;
      scroll.dispatchEvent(new Event("scroll"));
    });

    // Deep in the review the virtual window has left the top rows behind…
    expect(screen.queryByText("file-0.ts")).not.toBeInTheDocument();
    // …but the description row is pinned mounted, so the delivered text (and,
    // mid-generation, its mailbox poll loop) survives the scroll round-trip.
    expect(screen.getByText("Summarizes the reviewed change.")).toBeInTheDocument();
  });

  it("navigates an offscreen selected file through the virtualizer", async () => {
    const manyFiles = Array.from({ length: 1_000 }, (_, index) =>
      file(`src/file-${index}.ts`, 1, 0),
    );
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "commit_files") return Promise.resolve(manyFiles);
      if (command === "commit_file_diff") return Promise.resolve(diffFor(args.file as string));
      return Promise.resolve([]);
    });

    render(<StackedReview />);
    await screen.findByText("file-0.ts");
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_file_diff", {
        path: "/r",
        oid: "c1",
        file: "src/file-0.ts",
        full: false,
      }),
    );
    const fileZeroCalls = () =>
      invokeMock.mock.calls.filter(
        ([command, args]) =>
          command === "commit_file_diff" &&
          (args as Record<string, unknown>).file === "src/file-0.ts",
      ).length;
    const initialFileZeroCalls = fileZeroCalls();

    act(() => {
      useRepo.setState({
        selectedFile: { path: "src/file-900.ts", source: "commit" },
        fileSelectionRequestId: 1,
      });
    });

    const scroll = screen.getByTestId("stacked-review-scroll");
    await waitFor(() => expect(scroll.scrollTop).toBeGreaterThan(0));
    expect(await screen.findByText("file-900.ts")).toBeInTheDocument();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_file_diff", {
        path: "/r",
        oid: "c1",
        file: "src/file-900.ts",
        full: false,
      }),
    );

    // A manual scroll does not change selection. Re-selecting the same row in
    // the panel raises a new request id and must navigate back to its header.
    act(() => {
      scroll.scrollTop = 0;
      scroll.dispatchEvent(new Event("scroll"));
    });
    expect(scroll.scrollTop).toBe(0);
    act(() => {
      useRepo.setState({
        selectedFile: { path: "src/file-900.ts", source: "commit" },
        fileSelectionRequestId: 2,
      });
    });
    await waitFor(() => expect(scroll.scrollTop).toBeGreaterThan(0));

    // The two distant windows exceed the 24-file cache cap. Returning to the
    // first file re-fetches its size-preserving placeholder instead of keeping
    // every visited diff in memory forever.
    act(() => {
      useRepo.setState({
        selectedFile: { path: "src/file-0.ts", source: "commit" },
        fileSelectionRequestId: 3,
      });
    });
    await screen.findByText("file-0.ts");
    await waitFor(() => expect(fileZeroCalls()).toBeGreaterThan(initialFileZeroCalls));
  });

  it("evicts an offscreen diff that settles after the viewport has moved", async () => {
    const manyFiles = Array.from({ length: 1_000 }, (_, index) =>
      file(`src/file-${index}.ts`, 1, 0),
    );
    const lateFileZero = deferred<FileDiff>();
    let fileZeroCalls = 0;
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "commit_files") return Promise.resolve(manyFiles);
      if (command === "commit_file_diff") {
        const path = args.file as string;
        if (path === "src/file-0.ts" && ++fileZeroCalls === 1) {
          return lateFileZero.promise;
        }
        return Promise.resolve(diffFor(path));
      }
      return Promise.resolve([]);
    });

    render(<StackedReview />);
    await waitFor(() => expect(fileZeroCalls).toBe(1));

    act(() => {
      useRepo.setState({
        selectedFile: { path: "src/file-900.ts", source: "commit" },
        fileSelectionRequestId: 1,
      });
    });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_file_diff", {
        path: "/r",
        oid: "c1",
        file: "src/file-900.ts",
        full: false,
      }),
    );
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([command]) => command === "commit_file_diff").length,
      ).toBeGreaterThan(MAX_CACHED_STACKED_DIFFS),
    );

    await act(async () => {
      lateFileZero.resolve(diffFor("src/file-0.ts"));
      await lateFileZero.promise;
    });

    act(() => {
      useRepo.setState({
        selectedFile: { path: "src/file-0.ts", source: "commit" },
        fileSelectionRequestId: 2,
      });
    });
    await waitFor(() => expect(fileZeroCalls).toBe(2));
  });

  it("fetches a range review through the range file-list and file-diff commands", async () => {
    useUi.setState({
      stackedReview: {
        oid: "head",
        range: { base: "base", head: "head" },
        title: "Reviewing base..head",
      },
    });
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === "diff_range") return Promise.resolve([file("src/range.ts", 3, 1)]);
      if (command === "diff_range_file") return Promise.resolve(diffFor(args.file as string));
      return Promise.resolve([]);
    });

    render(<StackedReview />);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("diff_range", {
        path: "/r",
        base: "base",
        head: "head",
      }),
    );
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("diff_range_file", {
        path: "/r",
        base: "base",
        head: "head",
        file: "src/range.ts",
        full: false,
      }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("commit_files", expect.anything());
  });

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
