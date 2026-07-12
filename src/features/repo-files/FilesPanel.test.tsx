import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { FilesPanel } from "./FilesPanel";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const summary = { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false };

beforeEach(() => {
  invokeMock.mockReset();
  // The change-gutter baseline read fires (fire-and-forget) after every file
  // open/reload; default it to "no baseline" so it never consumes the content
  // one-shot mocks the tests queue. It runs after the awaited content read, so
  // the content `mockResolvedValueOnce`s are always consumed first.
  invokeMock.mockImplementation((cmd: string) =>
    cmd === "repo_file_head_text" ? Promise.resolve(null) : Promise.resolve(undefined),
  );
  useRepo.setState({ summary, repoFiles: null, fileView: null });
  useUi.setState({ confirm: null });
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

  it("reloadFileView is a no-op under an open edit session (never clobbers the draft)", async () => {
    useRepo.setState({
      fileView: {
        path: "a.ts",
        content: { text: "old", size: 3, truncated: false, binary: false },
        loading: false,
        error: null,
        edit: { draft: "my edits", baseSize: 3, saving: false, error: null },
      },
    });
    await useRepo.getState().reloadFileView();
    // The content is NOT re-read (so the draft is untouched); only the HEAD
    // baseline may refresh (for the change gutter after an external checkout).
    expect(invokeMock).not.toHaveBeenCalledWith("repo_file_text", expect.anything());
    expect(useRepo.getState().fileView?.edit?.draft).toBe("my edits");
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

  it("requestOpenRepoFile opens directly when the viewer is clean", async () => {
    invokeMock.mockResolvedValueOnce({ text: "B", size: 1, truncated: false, binary: false });
    useRepo.getState().requestOpenRepoFile("b.ts");
    await waitFor(() => expect(useRepo.getState().fileView?.path).toBe("b.ts"));
    expect(useUi.getState().confirm).toBeNull();
  });

  it("requestOpenRepoFile confirms (and defers the open) when the viewer is dirty", async () => {
    useRepo.setState({
      fileView: {
        path: "a.ts",
        content: { text: "old", size: 3, truncated: false, binary: false },
        loading: false,
        error: null,
        edit: { draft: "unsaved edits", baseSize: 3, saving: false, error: null },
      },
    });
    useRepo.getState().requestOpenRepoFile("b.ts");
    // No open yet — a confirm is pending and the dirty file is still shown.
    expect(invokeMock).not.toHaveBeenCalled();
    expect(useRepo.getState().fileView?.path).toBe("a.ts");
    expect(useUi.getState().confirm?.title).toBe("Discard unsaved changes?");

    // Confirming discards and opens the new file.
    invokeMock.mockResolvedValueOnce({ text: "B", size: 1, truncated: false, binary: false });
    useUi.getState().confirm!.onConfirm();
    await waitFor(() => expect(useRepo.getState().fileView?.path).toBe("b.ts"));
  });

  it("saveFileEdit: a stale save can't publish into a reopened session", async () => {
    useRepo.setState({
      fileView: {
        path: "a.ts",
        content: { text: "v1", size: 2, truncated: false, binary: false },
        loading: false,
        error: null,
        edit: { draft: "v2", baseSize: 2, saving: false, error: null },
      },
    });
    let resolveWrite!: (n: number) => void;
    invokeMock.mockImplementationOnce(() => new Promise((r) => (resolveWrite = r))); // write_repo_file
    const save = useRepo.getState().saveFileEdit();
    // The user closes and reopens the same file, then starts a fresh edit while
    // the first write is still in flight (a new save session).
    useRepo.getState().closeRepoFile();
    useRepo.setState({
      fileView: {
        path: "a.ts",
        content: { text: "external", size: 8, truncated: false, binary: false },
        loading: false,
        error: null,
      },
    });
    useRepo.getState().beginFileEdit();
    useRepo.getState().updateFileDraft("external edits");
    resolveWrite(2);
    await save;
    // The old save's result must not clobber the new session.
    expect(useRepo.getState().fileView?.content?.text).toBe("external");
    expect(useRepo.getState().fileView?.edit?.draft).toBe("external edits");
  });

  it("requestOpenRepoFile is a no-op while a save is in flight", () => {
    useRepo.setState({
      fileView: {
        path: "a.ts",
        content: { text: "x", size: 1, truncated: false, binary: false },
        loading: false,
        error: null,
        edit: { draft: "edited", baseSize: 1, saving: true, error: null },
      },
    });
    useRepo.getState().requestOpenRepoFile("b.ts");
    // No discard confirm and no navigation — the in-flight write can't be undone.
    expect(useUi.getState().confirm).toBeNull();
    expect(useRepo.getState().fileView?.path).toBe("a.ts");
  });

  it("discard confirm rechecks saving — a ⌘S after the dialog opens blocks navigation", () => {
    useRepo.setState({
      fileView: {
        path: "a.ts",
        content: { text: "x", size: 1, truncated: false, binary: false },
        loading: false,
        error: null,
        edit: { draft: "edited", baseSize: 1, saving: false, error: null },
      },
    });
    // Dirty but not saving → a discard confirm is offered.
    useRepo.getState().requestOpenRepoFile("b.ts");
    const confirm = useUi.getState().confirm;
    expect(confirm?.title).toBe("Discard unsaved changes?");
    // A save starts before the user confirms.
    useRepo.setState((s) => ({
      fileView: { ...s.fileView!, edit: { ...s.fileView!.edit!, saving: true } },
    }));
    confirm!.onConfirm();
    // Navigation is blocked (the write can't be undone); still on a.ts.
    expect(useRepo.getState().fileView?.path).toBe("a.ts");
    expect(invokeMock).not.toHaveBeenCalledWith("repo_file_text", expect.anything());
  });

  it("baseline fetch: a stale HEAD read can't overwrite a newer one", async () => {
    let headCalls = 0;
    let resolveStale!: (v: string) => void;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd !== "repo_file_head_text") return Promise.resolve(undefined);
      headCalls++;
      return headCalls === 1 ? new Promise((r) => (resolveStale = r)) : Promise.resolve("NEW");
    });
    useRepo.setState({
      fileView: {
        path: "a.ts",
        content: { text: "x", size: 1, truncated: false, binary: false },
        loading: false,
        error: null,
        edit: { draft: "x", baseSize: 1, saving: false, error: null },
      },
    });
    // Two baseline fetches (reloadFileView refreshes the baseline while editing).
    await useRepo.getState().reloadFileView(); // baseline #1 — pending
    await useRepo.getState().reloadFileView(); // baseline #2 — resolves "NEW"
    await waitFor(() => expect(useRepo.getState().fileView?.baseline).toBe("NEW"));
    // The older read now lands, but its generation is stale → dropped.
    resolveStale("OLD");
    await Promise.resolve();
    await Promise.resolve();
    expect(useRepo.getState().fileView?.baseline).toBe("NEW");
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
