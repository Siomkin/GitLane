import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRepo } from "@/store/repo";
import { useUi, fileMenuOf, MenuKind } from "@/store/ui";
import { emptyChanges } from "@/store/repoTypes";
import { FileContextMenu } from "./FileContextMenu";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const realRequestOpenRepoFile = useRepo.getState().requestOpenRepoFile;
const realDiscardFile = useRepo.getState().discardFile;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ text: "hi", size: 2, truncated: false, binary: false });
  useRepo.setState({
    requestOpenRepoFile: realRequestOpenRepoFile,
    discardFile: realDiscardFile,
    appendIgnorePattern: vi.fn().mockResolvedValue(undefined),
    revealInFileManager: vi.fn().mockResolvedValue(undefined),
    summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
    changes: emptyChanges,
    fileView: null,
  });
  useUi.setState({ menu: null, confirm: null, prompt: null });
});

const openMenu = (path = "src/App.tsx", staged = false) =>
  useUi.setState({ menu: { kind: MenuKind.File, state: { x: 10, y: 10, path, discard: { staged } } } });

describe("FileContextMenu", () => {
  it("renders nothing until a file menu is open", () => {
    const { container } = render(<FileContextMenu />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the file in the center pane and closes the menu", () => {
    const requestOpenRepoFile = vi.fn();
    useRepo.setState({
      requestOpenRepoFile,
      changes: {
        ...emptyChanges,
        unstaged: [{ path: "src/App.tsx", status: "M", add: 1, del: 0, binary: false }],
      },
    });
    openMenu();
    render(<FileContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(requestOpenRepoFile).toHaveBeenCalledWith("src/App.tsx");
    expect(fileMenuOf(useUi.getState())).toBeNull();
  });

  it("offers Discard, Ignore, Edit, Open, History, and Copy for an unstaged tracked file", () => {
    useRepo.setState({
      changes: {
        ...emptyChanges,
        unstaged: [{ path: "src/App.tsx", status: "M", add: 1, del: 0, binary: false }],
      },
    });
    openMenu();
    render(<FileContextMenu />);

    expect(screen.getByRole("menuitem", { name: "Discard changes" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Ignore…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete file" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "History" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Full path" })).toBeInTheDocument();
  });

  it("offers Edit + Delete + Ignore (no Discard/History) for an untracked file", () => {
    useRepo.setState({
      changes: {
        ...emptyChanges,
        unstaged: [{ path: "new.txt", status: "U", add: 1, del: 0, binary: false }],
      },
    });
    useUi.setState({ menu: { kind: MenuKind.File, state: { x: 10, y: 10, path: "new.txt", discard: { staged: false } } } });
    render(<FileContextMenu />);

    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete file" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Ignore…" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /discard/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "History" })).not.toBeInTheDocument();
  });

  it("offers Ignore on staged rows too", () => {
    useRepo.setState({
      changes: {
        ...emptyChanges,
        staged: [{ path: "src/App.tsx", status: "M", add: 1, del: 0, binary: false }],
      },
    });
    openMenu("src/App.tsx", true);
    render(<FileContextMenu />);

    expect(screen.getByRole("menuitem", { name: "Unstage & discard changes" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Ignore…" })).toBeInTheDocument();
  });

  it("offers GL-337 deferred verbs for a tracked working-tree file", () => {
    useRepo.setState({
      changes: {
        ...emptyChanges,
        unstaged: [{ path: "src/App.tsx", status: "M", add: 1, del: 0, binary: false }],
      },
      stashFile: vi.fn().mockResolvedValue(undefined),
      stopTracking: vi.fn().mockResolvedValue(undefined),
      createWorkingTreePatch: vi.fn().mockResolvedValue("wip-App.tsx.patch"),
      openPathDefault: vi.fn().mockResolvedValue(undefined),
    });
    openMenu();
    render(<FileContextMenu />);

    expect(screen.getByRole("menuitem", { name: "Stash this file" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Stop tracking" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Create patch" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(screen.getByRole("menuitem", { name: "Default Application" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Diff Tool" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Open Diff Tool" })).not.toBeInTheDocument();
  });

  it("confirms stash-this-file before calling the store action", () => {
    const stashFile = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      changes: {
        ...emptyChanges,
        unstaged: [{ path: "src/App.tsx", status: "M", add: 1, del: 0, binary: false }],
      },
      stashFile,
    });
    openMenu();
    render(<FileContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Stash this file" }));
    expect(useUi.getState().confirm?.title).toContain("Stash App.tsx");
    expect(stashFile).not.toHaveBeenCalled();
    useUi.getState().confirm!.onConfirm();
    expect(stashFile).toHaveBeenCalledWith("src/App.tsx");
  });

  it("hides stop-tracking for untracked files", () => {
    useRepo.setState({
      changes: {
        ...emptyChanges,
        unstaged: [{ path: "new.txt", status: "U", add: 1, del: 0, binary: false }],
      },
    });
    useUi.setState({ menu: { kind: MenuKind.File, state: { x: 10, y: 10, path: "new.txt", discard: { staged: false } } } });
    render(<FileContextMenu />);

    expect(screen.getByRole("menuitem", { name: "Stash this file" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Create patch" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Stop tracking" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(screen.getByRole("menuitem", { name: "Default Application" })).toBeInTheDocument();
  });

  it("omits Discard for renames but still offers Ignore / Open / History", () => {
    useRepo.setState({
      changes: {
        ...emptyChanges,
        unstaged: [
          {
            path: "src/App.tsx",
            previousPath: "src/OldApp.tsx",
            status: "R",
            add: 1,
            del: 1,
            binary: false,
          },
        ],
      },
    });
    // Discard is suppressed for renames inside the menu; Ignore/Open/History remain.
    useUi.setState({
      menu: { kind: MenuKind.File, state: { x: 10, y: 10, path: "src/App.tsx", discard: { staged: false } } },
    });
    render(<FileContextMenu />);

    expect(screen.queryByRole("menuitem", { name: /discard/i })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Ignore…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "History" })).toBeInTheDocument();
  });

  it("previews the exact file state and forwards its guard on confirmation", async () => {
    const discardFile = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      discardFile,
      changes: {
        ...emptyChanges,
        unstaged: [
          {
            path: "src/App.tsx",
            status: "M",
            add: 1,
            del: 0,
            binary: false,
          },
        ],
      },
    });
    invokeMock.mockResolvedValueOnce({
      summary: "Discard unstaged changes in src/App.tsx",
      details: ["Staged content will be preserved."],
      warnings: ["Unstaged edits are not recoverable."],
      expectedState: "discard-state-v1",
    });
    openMenu();
    render(<FileContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Discard changes" }));

    expect(fileMenuOf(useUi.getState())).toBeNull();
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
    expect(invokeMock).toHaveBeenCalledWith("preview_discard_file", {
      path: "/r",
      file: "src/App.tsx",
      previousFile: null,
      staged: false,
    });

    useUi.getState().confirm!.onConfirm();
    expect(discardFile).toHaveBeenCalledWith(
      "/r",
      "src/App.tsx",
      null,
      false,
      "discard-state-v1",
    );
  });

  it("fails closed when the file-state preview cannot be read", async () => {
    const discardFile = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      discardFile,
      changes: {
        ...emptyChanges,
        unstaged: [{ path: "src/App.tsx", status: "M", add: 1, del: 0, binary: false }],
      },
    });
    invokeMock.mockRejectedValueOnce(new Error("status unavailable"));
    openMenu();
    render(<FileContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Discard changes" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("preview_discard_file", expect.anything()));
    expect(useUi.getState().confirm).toBeNull();
    expect(discardFile).not.toHaveBeenCalled();
  });

  it("appends an ignore pattern from the Ignore submenu", () => {
    const appendIgnorePattern = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      appendIgnorePattern,
      changes: {
        ...emptyChanges,
        unstaged: [{ path: "infra/mcp.json", status: "U", add: 1, del: 0, binary: false }],
      },
    });
    useUi.setState({
      menu: { kind: MenuKind.File, state: { x: 10, y: 10, path: "infra/mcp.json", discard: { staged: false } } },
    });
    render(<FileContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Ignore…" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Ignore “mcp.json”" }));
    expect(appendIgnorePattern).toHaveBeenCalledWith("/infra/mcp.json", false);
    expect(fileMenuOf(useUi.getState())).toBeNull();
  });

  it("reveals the file in the OS file manager", () => {
    const revealInFileManager = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      revealInFileManager,
      changes: {
        ...emptyChanges,
        unstaged: [{ path: "src/App.tsx", status: "M", add: 1, del: 0, binary: false }],
      },
    });
    openMenu();
    render(<FileContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Show in/ }));
    expect(revealInFileManager).toHaveBeenCalledWith("src/App.tsx");
    expect(fileMenuOf(useUi.getState())).toBeNull();
  });

  it("previews and deletes an untracked file on confirmation", async () => {
    const discardFile = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      discardFile,
      changes: {
        ...emptyChanges,
        unstaged: [{ path: "new.txt", status: "U", add: 1, del: 0, binary: false }],
      },
    });
    invokeMock.mockResolvedValueOnce({
      summary: "Remove untracked file new.txt",
      details: ["The untracked worktree file will be removed."],
      warnings: ["These file changes cannot be recovered by GitLane."],
      expectedState: "delete-state-v1",
    });
    useUi.setState({ menu: { kind: MenuKind.File, state: { x: 10, y: 10, path: "new.txt", discard: { staged: false } } } });
    render(<FileContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete file" }));
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
    expect(invokeMock).toHaveBeenCalledWith("preview_discard_file", {
      path: "/r",
      file: "new.txt",
      previousFile: null,
      staged: false,
    });

    useUi.getState().confirm!.onConfirm();
    expect(discardFile).toHaveBeenCalledWith("/r", "new.txt", null, false, "delete-state-v1");
  });

  it("opens a custom ignore prompt with an anchored folder default", () => {
    useUi.setState({
      menu: { kind: MenuKind.File, state: { x: 10, y: 10, path: "infra/docker", dir: true, working: true } },
    });
    render(<FileContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Ignore folder…" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Custom pattern…" }));

    const prompt = useUi.getState().prompt;
    expect(prompt).not.toBeNull();
    expect(prompt?.defaultValue).toBe("/infra/docker/");
  });

  it("submits a custom ignore pattern from the prompt", () => {
    const appendIgnorePattern = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      appendIgnorePattern,
      changes: {
        ...emptyChanges,
        unstaged: [{ path: "new.txt", status: "U", add: 1, del: 0, binary: false }],
      },
    });
    useUi.setState({ menu: { kind: MenuKind.File, state: { x: 10, y: 10, path: "new.txt", discard: { staged: false } } } });
    render(<FileContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Ignore…" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Custom pattern…" }));
    useUi.getState().prompt!.onSubmit("*.tmp");
    expect(appendIgnorePattern).toHaveBeenCalledWith("*.tmp", false);
  });

  it("shows Ignore folder on a working-tree directory header", () => {
    useUi.setState({
      menu: { kind: MenuKind.File, state: { x: 10, y: 10, path: "src/features/changes", dir: true, working: true } },
    });
    render(<FileContextMenu />);

    expect(screen.getByRole("menuitem", { name: "Ignore folder…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Folder name" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Open file" })).not.toBeInTheDocument();
  });

  it("keeps Reveal + Copy on a committed directory header (no Restore / Ignore)", () => {
    useUi.setState({ menu: { kind: MenuKind.File, state: { x: 10, y: 10, path: "src/features/changes", dir: true } } });
    render(<FileContextMenu />);

    expect(screen.queryByRole("menuitem", { name: "Ignore folder…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Restore from this commit/ })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Show in/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Folder name" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Relative path" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Full path" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Open file" })).not.toBeInTheDocument();
  });

  it("copies the directory's relative path and closes the menu", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useUi.setState({ menu: { kind: MenuKind.File, state: { x: 10, y: 10, path: "src/features/changes", dir: true } } });
    render(<FileContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Relative path" }));
    expect(writeText).toHaveBeenCalledWith("src/features/changes");
    expect(fileMenuOf(useUi.getState())).toBeNull();
  });

  it("copies the directory's full path (repo root + relative)", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useUi.setState({ menu: { kind: MenuKind.File, state: { x: 10, y: 10, path: "src/features/changes", dir: true } } });
    render(<FileContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Full path" }));
    expect(writeText).toHaveBeenCalledWith("/r/src/features/changes");
  });

  it("offers Restore first for a committed file, then Open / Reveal / History / Copy", () => {
    useUi.setState({
      menu: { kind: MenuKind.File, state: {
        x: 10,
        y: 10,
        path: "src/App.tsx",
        restore: { commitOid: "abcdef0123456789abcdef0123456789abcdef01" },
      } },
    });
    render(<FileContextMenu />);

    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items[0]).toMatch(/Restore from this commit/);
    expect(screen.getByRole("menuitem", { name: "Open file" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Show in/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "History" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /discard/i })).not.toBeInTheDocument();
  });

  it("skips the write and says so when the worktree already matches the commit blob", async () => {
    const worktreeDiffersFromCommit = vi.fn().mockResolvedValue(false);
    const restorePathFromCommit = vi.fn().mockResolvedValue(undefined);
    const showToast = vi.fn();
    useRepo.setState({ worktreeDiffersFromCommit, restorePathFromCommit });
    useUi.setState({
      showToast,
      menu: { kind: MenuKind.File, state: {
        x: 10,
        y: 10,
        path: "src/App.tsx",
        restore: { commitOid: "abcdef0123456789abcdef0123456789abcdef01" },
      } },
    });
    render(<FileContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Restore from this commit…" }));
    await waitFor(() => expect(worktreeDiffersFromCommit).toHaveBeenCalled());
    // The early return happens before the confirm dialog, so this is the only
    // feedback the action produces — it must not be silent.
    expect(showToast).toHaveBeenCalledWith("src/App.tsx already matches abcdef0");
    // A no-op restore must not shell out to git nor prompt.
    expect(restorePathFromCommit).not.toHaveBeenCalled();
    expect(useUi.getState().confirm).toBeNull();
  });

  it("confirms Restore only when the worktree would change", async () => {
    const worktreeDiffersFromCommit = vi.fn().mockResolvedValue(true);
    const restorePathFromCommit = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ worktreeDiffersFromCommit, restorePathFromCommit });
    useUi.setState({
      menu: { kind: MenuKind.File, state: {
        x: 10,
        y: 10,
        path: "src/App.tsx",
        restore: { commitOid: "abcdef0123456789abcdef0123456789abcdef01" },
      } },
    });
    render(<FileContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Restore from this commit…" }));
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
    expect(useUi.getState().confirm?.title).toContain("Restore src/App.tsx");
    expect(restorePathFromCommit).not.toHaveBeenCalled();

    useUi.getState().confirm!.onConfirm();
    expect(restorePathFromCommit).toHaveBeenCalledWith(
      "abcdef0123456789abcdef0123456789abcdef01",
      "src/App.tsx",
    );
  });

  it("omits Restore when the menu has no restore target", () => {
    useUi.setState({ menu: { kind: MenuKind.File, state: { x: 10, y: 10, path: "src/App.tsx" } } });
    render(<FileContextMenu />);
    expect(screen.queryByRole("menuitem", { name: /Restore from this commit/ })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open file" })).toBeInTheDocument();
  });
});
