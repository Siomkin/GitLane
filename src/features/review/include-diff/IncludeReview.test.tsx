import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { DiffLine, DiffLineRange, FileDifferences, FileChange } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { emptyIpcInvoke } from "@/test/ipcFixtures";
import { summary } from "@/test/repoFixtures";
import { ReviewWorkspace } from "@/features/review/ReviewWorkspace";

// No layout in the DOM test environment: give the virtual list a viewport and
// rows a height, as ReviewWorkspace.test.tsx does.
beforeAll(() => {
  const isScroll = (el: HTMLElement) => /review-(unified|split)-scroll/.test(el.getAttribute("data-testid") ?? "");
  const rect = (height: number) =>
    ({ height, width: 600, top: 0, left: 0, right: 600, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return isScroll(this) ? 400 : 19;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 600 });
  // virtual-core sizes the scroll viewport from clientHeight/clientWidth.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.offsetHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return this.offsetWidth;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (this.hasAttribute("data-index")) return rect(19);
      return rect(isScroll(this) ? 400 : 0);
    },
  });
});

const l = (kind: DiffLine["kind"], oldNo: number | null, newNo: number | null, content: string): DiffLine => ({
  kind,
  oldNo,
  newNo,
  content,
});
const lines = [
  l("ctx", 1, 1, "x"),
  l("del", 2, null, "a"),
  l("add", null, 2, "A"),
  l("ctx", 3, 3, "y"),
  l("ctx", 4, 4, "z"),
  l("del", 5, null, "b"),
  l("add", null, 5, "B"),
];
const stageFirst: DiffLineRange = { hunkIndex: 0, lineStart: 1, expected: lines.slice(1, 3) };
const unstageSecond: DiffLineRange = { hunkIndex: 0, lineStart: 1, expected: lines.slice(5, 7) };
const differences: FileDifferences = {
  diff: { path: "a.ts", status: "M", add: 2, del: 2, binary: false, truncated: false, hunks: [{ header: "@@ -1,5 +1,5 @@", lines }] },
  differences: [
    { hunkIndex: 0, lineStart: 1, lineEnd: 2, inclusion: "excluded", stage: [stageFirst], unstage: [] },
    { hunkIndex: 0, lineStart: 5, lineEnd: 6, inclusion: "included", stage: [], unstage: [unstageSecond] },
  ],

  wholeFile: false,
};
const file = (path: string): FileChange => ({ path, status: "M", add: 1, del: 1, binary: false });

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "working_file_differences") return Promise.resolve(differences);
    if (cmd === "apply_line_range" || cmd === "revert_line_range") return Promise.resolve("ok");
    return emptyIpcInvoke(cmd);
  });
  useRepo.setState({
    summary,
    changes: { staged: [file("a.ts")], unstaged: [file("a.ts"), file("b.ts")], conflicted: [], advanced: emptyAdvancedState },
    selectedFile: { path: "a.ts", source: "unstaged" },
    fileDiff: null,
    diffLoading: false,
  });
  useUi.setState({ changesView: "include", confirm: null });
});

const renderInclude = () => render(<ReviewWorkspace onBack={() => {}} />);

describe("IncludeReview", () => {
  it("shows the counts and the file position", async () => {
    renderInclude();
    expect(await screen.findByText("2 differences, 1 included")).toBeInTheDocument();
    expect(screen.getByLabelText("File position")).toHaveTextContent("1/2 files");
  });

  it("includes an excluded difference with its stage ranges and excludes an included one", async () => {
    renderInclude();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Include this difference" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("apply_line_range", {
        path: "/repo",
        request: { file: "a.ts", staged: false, ranges: [stageFirst] },
      }),
    );
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Exclude this difference" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("checkbox", { name: "Exclude this difference" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("apply_line_range", {
        path: "/repo",
        request: { file: "a.ts", staged: true, ranges: [unstageSecond] },
      }),
    );
  });

  it("reverts only an excluded difference, after confirmation", async () => {
    renderInclude();
    const [excluded, included] = await screen.findAllByRole("button", { name: "Revert this difference" });
    expect(included).toBeDisabled();
    expect(included).toHaveAttribute("title", expect.stringMatching(/Exclude/));
    fireEvent.click(excluded);
    const confirm = useUi.getState().confirm;
    expect(confirm?.title).toBe("Revert this difference?");
    expect(invokeMock).not.toHaveBeenCalledWith("revert_line_range", expect.anything());
    confirm?.onConfirm();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("revert_line_range", {
        path: "/repo",
        request: { file: "a.ts", staged: false, ranges: [stageFirst] },
      }),
    );
  });

  it("moves to the next file with the file-navigation chord", async () => {
    renderInclude();
    await screen.findByText("2 differences, 1 included");
    fireEvent.keyDown(window, { code: "ArrowRight", altKey: true });
    await waitFor(() => expect(useRepo.getState().selectedFile?.path).toBe("b.ts"));
  });

  it("opens the file editor from the pencil, read-only only for mixed line endings", async () => {
    const content = (text: string) => ({ text, size: text.length, truncated: false, binary: false, expectedState: "s1" });
    const reads = [content("x\r\na\r\n"), content("x\r\na\n")];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "working_file_differences") return Promise.resolve(differences);
      if (cmd === "repo_file_text") return Promise.resolve(reads.shift());
      return emptyIpcInvoke(cmd);
    });
    renderInclude();
    fireEvent.click(await screen.findByRole("button", { name: "Edit file" }));
    await waitFor(() => expect(useRepo.getState().fileView?.edit?.draft).toBe("x\na\n"));

    useRepo.setState({ fileView: null });
    fireEvent.click(screen.getByRole("button", { name: "Edit file" }));
    await waitFor(() => expect(useRepo.getState().fileView?.content?.text).toBe("x\r\na\n"));
    expect(useRepo.getState().fileView?.edit).toBeFalsy();
  });

  it("refetches the whole file, hides hunk headers, and keeps the checkboxes", async () => {
    invokeMock.mockImplementation((cmd: string, args?: { wholeFile?: boolean }) => {
      if (cmd === "working_file_differences") return Promise.resolve({ ...differences, wholeFile: !!args?.wholeFile });
      if (cmd === "apply_line_range") return Promise.resolve("ok");
      return emptyIpcInvoke(cmd);
    });
    renderInclude();
    expect(await screen.findByText("@@ -1,5 +1,5 @@")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Whole file" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("working_file_differences", { path: "/repo", file: "a.ts", wholeFile: true }),
    );
    await waitFor(() => expect(screen.queryByText("@@ -1,5 +1,5 @@")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: "Include this difference" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("apply_line_range", {
        path: "/repo",
        request: { file: "a.ts", staged: false, ranges: [stageFirst] },
      }),
    );
  });

  it("says when a file is too long to show whole", async () => {
    renderInclude();
    fireEvent.click(await screen.findByRole("button", { name: "Whole file" }));
    expect(await screen.findByText(/too long to show whole/)).toBeInTheDocument();
  });

  it("labels the split sides HEAD and Working tree", async () => {
    useRepo.setState({ summary: { ...summary, headOid: "3059071abcdef" } });
    const { rerender } = renderInclude();
    await screen.findByText("2 differences, 1 included");
    expect(screen.queryByText("Working tree")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    rerender(<ReviewWorkspace onBack={() => {}} />);
    expect(await screen.findByText("HEAD · 3059071")).toBeInTheDocument();
    expect(screen.getByText("Working tree")).toBeInTheDocument();
  });

  it("leaves the Staging area view on the bucket diff", () => {
    useUi.setState({ changesView: "staging" });
    useRepo.setState({ fileDiff: differences.diff });
    renderInclude();
    expect(screen.queryByRole("toolbar", { name: "Include diff" })).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("working_file_differences", expect.anything());
  });
});
