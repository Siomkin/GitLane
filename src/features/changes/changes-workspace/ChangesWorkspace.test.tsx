// The multi-file review's diff cache contract (GL-173): the cache is valid for
// exactly one working-tree snapshot. A new `changes` object (watcher refresh,
// focus re-sync, repo switch) must refetch expanded files — the key's
// status/counts cannot stand in for content — while within one snapshot,
// collapse/expand reuses the cached diff.
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { FileChange, FileDiff, WorkingChanges } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi, fileMenuOf, FileMenuKind } from "@/store/ui";
import { emptyChanges } from "@/store/repoTypes";
import { ChangesWorkspace } from "./ChangesWorkspace";

const file = (path: string, add = 1, del = 0): FileChange => ({
  path,
  status: "M",
  add,
  del,
  binary: false,
});

const diffOf = (path: string, marker: string): FileDiff => ({
  path,
  status: "M",
  add: 1,
  del: 0,
  binary: false,
  truncated: false,
  hunks: [
    {
      header: "@@ -1 +1 @@",
      lines: [{ kind: "add", oldNo: null, newNo: 1, content: marker }],
    },
  ],
});

const snapshot = (files: FileChange[]): WorkingChanges => ({
  ...emptyChanges,
  unstaged: files,
});

const summaryFor = (path: string) => ({
  path,
  workdir: path,
  headBranch: "main",
  headOid: "c1",
  detached: false,
});

const fileDiffCalls = (filePath: string) =>
  invokeMock.mock.calls.filter(
    ([cmd, args]) => cmd === "file_diff" && (args as { file: string }).file === filePath,
  );

beforeEach(() => {
  invokeMock.mockReset();
  useRepo.setState({
    summary: summaryFor("/r"),
    changes: snapshot([file("a.ts")]),
    // The header click also focuses the file in the right panel; stub it so
    // `file_diff` call counts belong to the workspace's own cache alone.
    selectFile: vi.fn(),
  });
});

describe("ChangesWorkspace — diff cache identity (GL-173)", () => {
  it("refetches an expanded file when a new snapshot arrives with identical counts", async () => {
    let content = "old content";
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "file_diff" ? Promise.resolve(diffOf("a.ts", content)) : Promise.resolve(null),
    );

    const { container } = render(<ChangesWorkspace onBack={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain("old content"));

    // External edit that keeps status and add/del identical: the watcher
    // refresh publishes a NEW snapshot object with equal fields.
    content = "new content";
    act(() => {
      useRepo.setState({ changes: snapshot([file("a.ts")]) });
    });

    await waitFor(() => expect(container.textContent).toContain("new content"));
  });

  it("does not reuse another repo's cached diff for a same-path file", async () => {
    invokeMock.mockImplementation((cmd: string, args: unknown) =>
      cmd === "file_diff"
        ? Promise.resolve(diffOf("a.ts", `diff from ${(args as { path: string }).path}`))
        : Promise.resolve(null),
    );

    const { container } = render(<ChangesWorkspace onBack={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain("diff from /r"));

    act(() => {
      useRepo.setState({ summary: summaryFor("/other"), changes: snapshot([file("a.ts")]) });
    });

    await waitFor(() => expect(container.textContent).toContain("diff from /other"));
  });

  it("reuses the cached diff across collapse/expand within one snapshot", async () => {
    invokeMock.mockImplementation((cmd: string, args: unknown) =>
      cmd === "file_diff"
        ? Promise.resolve(diffOf((args as { file: string }).file, `diff of ${(args as { file: string }).file}`))
        : Promise.resolve(null),
    );
    useRepo.setState({ changes: snapshot([file("a.ts"), file("b.ts")]) });

    const { container, getByText } = render(<ChangesWorkspace onBack={() => {}} />);
    // The first file auto-expands and fetches once.
    await waitFor(() => expect(container.textContent).toContain("diff of a.ts"));
    expect(fileDiffCalls("a.ts")).toHaveLength(1);

    // Collapse and re-expand a.ts within the same snapshot → served from cache.
    fireEvent.click(getByText("a.ts"));
    expect(container.textContent).not.toContain("diff of a.ts");
    fireEvent.click(getByText("a.ts"));
    await waitFor(() => expect(container.textContent).toContain("diff of a.ts"));
    expect(fileDiffCalls("a.ts")).toHaveLength(1);

    // Expanding the other file fetches it without refetching the first.
    fireEvent.click(getByText("b.ts"));
    await waitFor(() => expect(container.textContent).toContain("diff of b.ts"));
    expect(fileDiffCalls("a.ts")).toHaveLength(1);
    expect(fileDiffCalls("b.ts")).toHaveLength(1);
  });
});

// Behavior pinned before the GL-174 folder-module split: default expansion,
// manual-collapse persistence across refreshes, and per-file stage/unstage
// dispatch at the row checkbox.
describe("ChangesWorkspace — expansion and staging dispatch (GL-174)", () => {
  it("expands only the first file by default", async () => {
    invokeMock.mockImplementation((cmd: string, args: unknown) =>
      cmd === "file_diff"
        ? Promise.resolve(diffOf((args as { file: string }).file, `diff of ${(args as { file: string }).file}`))
        : Promise.resolve(null),
    );
    useRepo.setState({ changes: snapshot([file("a.ts"), file("b.ts")]) });

    const { container } = render(<ChangesWorkspace onBack={() => {}} />);

    await waitFor(() => expect(container.textContent).toContain("diff of a.ts"));
    expect(container.textContent).not.toContain("diff of b.ts");
    expect(fileDiffCalls("b.ts")).toHaveLength(0); // collapsed → never fetched
  });

  it("does not fight a manual collapse when a same-paths snapshot arrives", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "file_diff" ? Promise.resolve(diffOf("a.ts", "diff of a.ts")) : Promise.resolve(null),
    );

    const { container, getByText } = render(<ChangesWorkspace onBack={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain("diff of a.ts"));

    fireEvent.click(getByText("a.ts"));
    expect(container.textContent).not.toContain("diff of a.ts");

    // A watcher refresh with the same file set must not re-open the file.
    act(() => {
      useRepo.setState({ changes: snapshot([file("a.ts")]) });
    });
    await waitFor(() => expect(container.textContent).toContain("a.ts"));
    expect(container.textContent).not.toContain("diff of a.ts");
  });

  it("dispatches stage for an unstaged row and unstage for a staged row", async () => {
    const stageFile = vi.fn();
    const unstageFile = vi.fn();
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "file_diff" ? Promise.resolve(diffOf("a.ts", "diff of a.ts")) : Promise.resolve(null),
    );
    useRepo.setState({
      changes: { ...emptyChanges, unstaged: [file("a.ts")], staged: [file("b.ts")] },
      stageFile,
      unstageFile,
    });

    const { getAllByTitle } = render(<ChangesWorkspace onBack={() => {}} />);

    fireEvent.click(getAllByTitle("Stage file")[0]);
    expect(stageFile).toHaveBeenCalledWith("a.ts");
    fireEvent.click(getAllByTitle("Unstage file")[0]);
    expect(unstageFile).toHaveBeenCalledWith("b.ts");
  });
});

describe("ChangesWorkspace — expansion resets per repo (GL-174 review)", () => {
  it("clears the previous repo's expansion choices on a repo switch", async () => {
    invokeMock.mockImplementation((cmd: string, args: unknown) =>
      cmd === "file_diff"
        ? Promise.resolve(diffOf((args as { file: string }).file, `diff of ${(args as { file: string }).file}`))
        : Promise.resolve(null),
    );
    useRepo.setState({ changes: snapshot([file("a.ts"), file("b.ts")]) });

    const { container, getByText } = render(<ChangesWorkspace onBack={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain("diff of a.ts"));
    fireEvent.click(getByText("b.ts"));
    await waitFor(() => expect(container.textContent).toContain("diff of b.ts"));

    // Same path names in the next repo: only the default first file opens —
    // b.ts must not inherit the previous repo's expansion.
    act(() => {
      useRepo.setState({
        summary: summaryFor("/other"),
        changes: snapshot([file("a.ts"), file("b.ts")]),
      });
    });

    await waitFor(() => expect(container.textContent).toContain("diff of a.ts"));
    expect(container.textContent).not.toContain("diff of b.ts");
  });

  it("collapses a row in place when its file is staged", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "file_diff" ? Promise.resolve(diffOf("a.ts", "diff of a.ts")) : Promise.resolve(null),
    );
    useRepo.setState({ stageFile: vi.fn() });

    const { container, getByTitle } = render(<ChangesWorkspace onBack={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain("diff of a.ts"));

    // Approving the file keeps its slot but collapses the section.
    fireEvent.click(getByTitle("Stage file"));
    expect(container.textContent).not.toContain("diff of a.ts");
  });
});

describe("ChangesWorkspace — file context menu (GL-337)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    useUi.setState({ menu: null });
    useRepo.setState({
      summary: summaryFor("/r"),
      changes: snapshot([file("a.ts")]),
      selectFile: vi.fn(),
    });
  });

  it("right-clicking a review row opens the shared working-tree menu", () => {
    const { getByText } = render(<ChangesWorkspace onBack={() => {}} />);
    fireEvent.contextMenu(getByText("a.ts"));
    const menu = fileMenuOf(useUi.getState());
    expect(menu?.path).toBe("a.ts");
    expect(menu).toMatchObject({ kind: FileMenuKind.Working, discard: { staged: false } });
  });

  it("marks the menu staged when the review row comes from the staged bucket", () => {
    useRepo.setState({
      changes: { ...emptyChanges, staged: [file("b.ts")] },
    });
    const { getByText } = render(<ChangesWorkspace onBack={() => {}} />);
    fireEvent.contextMenu(getByText("b.ts"));
    expect(fileMenuOf(useUi.getState())?.path).toBe("b.ts");
    expect(fileMenuOf(useUi.getState())).toMatchObject({
      kind: FileMenuKind.Working,
      discard: { staged: true },
    });
  });
});
