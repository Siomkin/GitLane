import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRepo } from "../../store/repo";
import { FilesPanel } from "./FilesPanel";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const summary = { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false };

beforeEach(() => {
  invokeMock.mockReset();
  useRepo.setState({ summary, repoFiles: null, fileView: null });
});

describe("FilesPanel", () => {
  it("loads the listing on first mount and renders the collapsed tree", async () => {
    invokeMock.mockImplementation((command: string) =>
      command === "list_repo_files"
        ? Promise.resolve(["README.md", "src/App.tsx", "src/main.tsx"])
        : Promise.resolve(null),
    );
    render(<FilesPanel />);
    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("list_repo_files", { path: "/r" });
    // Directories start collapsed: the folder row shows, its children don't.
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.queryByText("App.tsx")).not.toBeInTheDocument();
  });

  it("expands a directory on click and opens a file in the center pane", async () => {
    invokeMock.mockImplementation((command: string) =>
      command === "list_repo_files"
        ? Promise.resolve(["src/App.tsx"])
        : Promise.resolve({ text: "hi", size: 2, truncated: false, binary: false }),
    );
    render(<FilesPanel />);
    fireEvent.click(await screen.findByText("src"));
    fireEvent.click(await screen.findByText("App.tsx"));
    await waitFor(() => expect(useRepo.getState().fileView?.path).toBe("src/App.tsx"));
    expect(invokeMock).toHaveBeenCalledWith("repo_file_text", {
      path: "/r",
      file: "src/App.tsx",
      maxBytes: null,
    });
  });

  it("filters as a flat full-path list", async () => {
    invokeMock.mockResolvedValue(["src/deep/Match.tsx", "other.ts"]);
    render(<FilesPanel />);
    await screen.findByText("other.ts");
    fireEvent.change(screen.getByLabelText("Filter repository files"), {
      target: { value: "match" },
    });
    expect(screen.getByText("src/deep/Match.tsx")).toBeInTheDocument();
    expect(screen.queryByText("other.ts")).not.toBeInTheDocument();
  });

  it("ignores a superseded listing response resolved out of order", async () => {
    // Two loadRepoFiles calls; the first resolves LAST. The newer one must win.
    let resolveFirst: (v: string[]) => void = () => {};
    invokeMock
      .mockImplementationOnce(() => new Promise<string[]>((r) => (resolveFirst = r)))
      .mockImplementationOnce(() => Promise.resolve(["new.ts"]));
    const p1 = useRepo.getState().loadRepoFiles();
    const p2 = useRepo.getState().loadRepoFiles();
    await p2;
    resolveFirst(["stale.ts"]);
    await p1;
    expect(useRepo.getState().repoFiles?.files).toEqual(["new.ts"]);
  });

  it("does not resurrect a file view whose open resolved after it was closed", async () => {
    let resolve: (v: unknown) => void = () => {};
    invokeMock.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const p = useRepo.getState().openRepoFile("src/App.tsx");
    useRepo.getState().closeRepoFile();
    resolve({ text: "late", size: 4, truncated: false, binary: false });
    await p;
    expect(useRepo.getState().fileView).toBeNull();
  });

  it("ignores a superseded open when a newer file open is in flight", async () => {
    let resolveA: (v: unknown) => void = () => {};
    invokeMock
      .mockImplementationOnce(() => new Promise((r) => (resolveA = r)))
      .mockImplementationOnce(() =>
        Promise.resolve({ text: "B", size: 1, truncated: false, binary: false }),
      );
    const pa = useRepo.getState().openRepoFile("a.ts");
    const pb = useRepo.getState().openRepoFile("b.ts");
    await pb;
    resolveA({ text: "A", size: 1, truncated: false, binary: false });
    await pa;
    // B was opened last; A's late response must not overwrite it.
    expect(useRepo.getState().fileView?.path).toBe("b.ts");
    expect(useRepo.getState().fileView?.content?.text).toBe("B");
  });

  it("does not republish a listing after the slice was reset (repo switch/close)", async () => {
    let resolve: (v: string[]) => void = () => {};
    invokeMock.mockImplementationOnce(() => new Promise<string[]>((r) => (resolve = r)));
    const p = useRepo.getState().loadRepoFiles();
    // Simulate a lifecycle reset nulling the slice while the request is in flight.
    useRepo.setState({ repoFiles: null });
    resolve(["stale.ts"]);
    await p;
    expect(useRepo.getState().repoFiles).toBeNull();
  });

  it("clears sibling inspection surfaces when opening a file (a real route)", async () => {
    invokeMock.mockResolvedValue({ text: "x", size: 1, truncated: false, binary: false });
    useRepo.setState({
      compare: { base: "a", head: "b" } as never,
      fileHistory: { path: "old.ts" } as never,
    });
    await useRepo.getState().openRepoFile("src/App.tsx");
    expect(useRepo.getState().compare).toBeNull();
    expect(useRepo.getState().fileHistory).toBeNull();
    expect(useRepo.getState().fileView?.path).toBe("src/App.tsx");
  });

  it("closes the viewer when the user navigates to a file or WIP", async () => {
    const open = { path: "a.ts", content: null, loading: false, error: null };
    // Selecting a working/commit file dismisses the standalone viewer.
    useRepo.setState({ fileView: { ...open }, changes: undefined as never });
    invokeMock.mockResolvedValue({ path: "b.ts", hunks: [], truncated: false, binary: false });
    await useRepo.getState().selectFile("b.ts", "unstaged");
    expect(useRepo.getState().fileView).toBeNull();
    // Selecting WIP dismisses it too.
    useRepo.setState({ fileView: { ...open } });
    useRepo.getState().selectWip();
    expect(useRepo.getState().fileView).toBeNull();
  });

  it("reloadFileView swaps content in place (watcher/checkout), keeping the viewer open", async () => {
    useRepo.setState({
      fileView: { path: "a.ts", content: { text: "old", size: 3, truncated: false, binary: false }, loading: false, error: null },
    });
    invokeMock.mockResolvedValueOnce({ text: "new", size: 3, truncated: false, binary: false });
    await useRepo.getState().reloadFileView();
    expect(useRepo.getState().fileView?.content?.text).toBe("new");
  });

  it("reloadFileView closes the viewer when the file is gone (e.g. after checkout)", async () => {
    useRepo.setState({
      fileView: { path: "gone.ts", content: { text: "x", size: 1, truncated: false, binary: false }, loading: false, error: null },
    });
    invokeMock.mockRejectedValueOnce("stat gone.ts: No such file or directory");
    await useRepo.getState().reloadFileView();
    expect(useRepo.getState().fileView).toBeNull();
  });

  it("reloadFileView keeps the last-good content on a transient read error", async () => {
    const good = { text: "still here", size: 10, truncated: false, binary: false };
    useRepo.setState({
      fileView: { path: "a.ts", content: good, loading: false, error: null },
    });
    invokeMock.mockRejectedValueOnce("temporary glitch");
    await useRepo.getState().reloadFileView();
    expect(useRepo.getState().fileView?.content?.text).toBe("still here");
  });

  it.each([
    ["non-regular entry (submodule after checkout)", "refusing to read non-regular file: \"sub\"", true],
    ["Windows missing wording", "The system cannot find the file specified.", true],
    ["permission denied (transient)", "open a.ts: Permission denied", false],
    ["path traversal rejection", "path escapes the worktree", false],
  ])("reloadFileView closes only on a genuinely-missing file — %s", async (_label, message, closes) => {
    const good = { text: "keep", size: 4, truncated: false, binary: false };
    useRepo.setState({ fileView: { path: "a.ts", content: good, loading: false, error: null } });
    invokeMock.mockRejectedValueOnce(message);
    await useRepo.getState().reloadFileView();
    if (closes) expect(useRepo.getState().fileView).toBeNull();
    else expect(useRepo.getState().fileView?.content?.text).toBe("keep");
  });

  it("reloadFileView: an older reload can't overwrite a newer one", async () => {
    useRepo.setState({
      fileView: { path: "a.ts", content: { text: "v0", size: 2, truncated: false, binary: false }, loading: false, error: null },
    });
    let resolveOld: (v: unknown) => void = () => {};
    invokeMock
      .mockImplementationOnce(() => new Promise((r) => (resolveOld = r)))
      .mockResolvedValueOnce({ text: "v2", size: 2, truncated: false, binary: false });
    const older = useRepo.getState().reloadFileView();
    const newer = useRepo.getState().reloadFileView();
    await newer;
    resolveOld({ text: "v1", size: 2, truncated: false, binary: false });
    await older;
    expect(useRepo.getState().fileView?.content?.text).toBe("v2");
  });

  it("reloadFileView defers to a concurrent user-driven open", async () => {
    useRepo.setState({
      fileView: { path: "a.ts", content: { text: "old", size: 3, truncated: false, binary: false }, loading: false, error: null },
    });
    let resolveReload: (v: unknown) => void = () => {};
    invokeMock
      .mockImplementationOnce(() => new Promise((r) => (resolveReload = r))) // reload a.ts
      .mockResolvedValueOnce({ text: "B", size: 1, truncated: false, binary: false }); // open b.ts
    const reload = useRepo.getState().reloadFileView();
    await useRepo.getState().openRepoFile("b.ts");
    resolveReload({ text: "A-late", size: 6, truncated: false, binary: false });
    await reload;
    // The user opened b.ts; the late a.ts reload must not republish.
    expect(useRepo.getState().fileView?.path).toBe("b.ts");
    expect(useRepo.getState().fileView?.content?.text).toBe("B");
  });

  it("surfaces a listing failure with a retry", async () => {
    invokeMock.mockRejectedValueOnce("boom");
    invokeMock.mockResolvedValueOnce(["ok.ts"]);
    render(<FilesPanel />);
    expect(await screen.findByText("Couldn't list files.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("ok.ts")).toBeInTheDocument();
  });
});
