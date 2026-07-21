import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { DiscardAllPreview, FileChange } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { FileListView } from "@/lib/ui";
import { useTerminalAgents } from "@/store/terminalAgents";
import { FileContextMenu } from "@/components/chrome/overlays";
import { WorkingInspector } from "./WorkingInspector";

const staged = (path: string): FileChange => ({ path, status: "M", add: 1, del: 0, binary: false });

beforeEach(() => {
  // Reset the git-domain slice this component reads to a clean, empty tree.
  useRepo.setState({ changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState }, selectedFile: null });
  // The changed-files view is now shared ui state (persists across the app), so
  // reset it per test — otherwise a prior test's Tree toggle leaks in.
  useUi.setState({ fileMenu: null, fileListView: FileListView.Path });
  // The embedded commit composer reads the terminal-agents store on render.
  // Stub it so the mocked `invoke` can't leave `agents` unset (its loader would
  // otherwise resolve to a non-array and crash `selectEnabledAgents`).
  useTerminalAgents.setState({ agents: [], loading: false, error: null, loadAgents: vi.fn(async () => {}) });
});

describe("WorkingInspector", () => {
  it("shows the empty state when there are no changes", () => {
    render(<WorkingInspector onOpenChanges={() => {}} />);
    expect(screen.getByRole("heading", { name: /0 changes on/i })).toBeInTheDocument();
    // Both the Unstaged and Staged sections render their "No files." placeholder.
    expect(screen.getAllByText("No files.")).toHaveLength(2);
  });

  it("replaces Start commit with an inline composer disabled for an empty stage", () => {
    render(<WorkingInspector onOpenChanges={() => {}} />);
    expect(screen.queryByRole("button", { name: "Start commit" })).not.toBeInTheDocument();
    // The composer mounts as its collapsed bar; expanding reveals the editor.
    fireEvent.click(screen.getByRole("button", { name: "Expand commit composer" }));
    expect(screen.getByRole("textbox", { name: "Commit summary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Commit 0 files/ })).toBeDisabled();
  });

  it("keeps the inline composer in the main inspector once something is staged", () => {
    // selectedFile already points at the staged file, so the keep-selection
    // effect is a no-op (no async selectFile → no IPC needed here).
    useRepo.setState({
      changes: { staged: [staged("a.ts")], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
      selectedFile: { path: "a.ts", source: "staged" },
    });
    render(<WorkingInspector onOpenChanges={() => {}} />);
    expect(screen.queryByRole("button", { name: "Start commit" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand commit composer" })).toBeInTheDocument();
  });

  it("disables staging for a visible path outside sparse checkout", () => {
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [staged("docs/hidden.txt")],
        conflicted: [],
        advanced: {
          submodules: [],
          lfs: { detected: false, installed: null, issues: [], patterns: [] },
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["/*", "!/*/", "/src/"] },
        },
      },
      selectedFile: { path: "docs/hidden.txt", source: "unstaged" },
    });
    render(<WorkingInspector onOpenChanges={() => {}} />);

    const stage = screen.getByRole("button", { name: "Stage file" });
    expect(stage).toBeDisabled();
    expect(stage).toHaveAttribute(
      "title",
      "Outside sparse checkout. Expand the sparse checkout or use git add --sparse.",
    );
  });

  it("right-clicking an unstaged row opens the file context menu for that path", () => {
    useRepo.setState({
      changes: { staged: [], unstaged: [staged("src/a.ts")], conflicted: [], advanced: emptyAdvancedState },
      selectedFile: { path: "src/a.ts", source: "unstaged" },
    });
    render(<WorkingInspector onOpenChanges={() => {}} />);
    fireEvent.contextMenu(screen.getByText("a.ts"));
    const menu = useUi.getState().fileMenu;
    expect(menu?.path).toBe("src/a.ts");
    expect(menu?.discard?.staged).toBe(false);
  });

  it("right-clicking a staged row marks the menu as staged", () => {
    useRepo.setState({
      changes: { staged: [staged("src/b.ts")], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
      selectedFile: { path: "src/b.ts", source: "staged" },
    });
    render(<WorkingInspector onOpenChanges={() => {}} />);
    fireEvent.contextMenu(screen.getByText("b.ts"));
    expect(useUi.getState().fileMenu?.discard?.staged).toBe(true);
  });

  it("omits discard (copy-only) when right-clicking a renamed file", () => {
    // Discard is single-path and can't restore a rename's old side (unlike
    // stage/unstage, which move both after GL-127), so the menu opens copy-only
    // (no discard target) rather than half-undo the rename.
    useRepo.setState({
      changes: { staged: [{ path: "src/new.ts", status: "R", add: 0, del: 0, binary: false }], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
      selectedFile: { path: "src/new.ts", source: "staged" },
    });
    render(<WorkingInspector onOpenChanges={() => {}} />);
    fireEvent.contextMenu(screen.getByText("new.ts"));
    const menu = useUi.getState().fileMenu;
    expect(menu?.path).toBe("src/new.ts");
    expect(menu?.discard).toBeUndefined();
  });

  it("groups working files into a tree and stages a whole folder from the roll-up", async () => {
    const stagePaths = vi.fn();
    useRepo.setState({
      changes: { staged: [], unstaged: [staged("src/a.ts"), staged("src/b.ts")], conflicted: [], advanced: emptyAdvancedState },
      selectedFile: { path: "src/a.ts", source: "unstaged" },
      stagePaths,
    });
    const user = userEvent.setup();
    render(<WorkingInspector onOpenChanges={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Tree" }));

    // Both files now sit under one directory header.
    const header = screen.getByText("src").closest(".group") as HTMLElement;
    expect(header).toBeTruthy();

    // The folder roll-up stages every file under it in one action.
    await user.click(within(header).getByRole("button", { name: "Stage" }));
    expect(stagePaths).toHaveBeenCalledWith(["src/a.ts", "src/b.ts"]);
  });

  it("shows the Path/Tree toggle for a conflict-only tree and groups conflicts under a folder", async () => {
    // Mid-merge the staged/unstaged lists can be empty while conflicts remain;
    // the toggle must still appear (it drives the read-only conflicts list) and
    // Tree view must group them — GL-28 review follow-up.
    const conflict = (path: string): FileChange => ({ path, status: "C", add: 0, del: 0, binary: false });
    useRepo.setState({
      changes: { staged: [], unstaged: [], conflicted: [conflict("src/a.ts"), conflict("src/b.ts")], advanced: emptyAdvancedState },
      selectedFile: null,
    });
    const user = userEvent.setup();
    render(<WorkingInspector onOpenChanges={() => {}} />);

    const pathBtn = screen.getByRole("button", { name: "Path" });
    const treeBtn = screen.getByRole("button", { name: "Tree" });
    expect(pathBtn).toHaveAttribute("aria-pressed", "true");
    expect(treeBtn).toHaveAttribute("aria-pressed", "false");

    // Switching to Tree regroups the conflicts under one directory header (in
    // Path view "src" only appears as per-row dirnames).
    await user.click(treeBtn);
    expect(treeBtn).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("src")).toBeInTheDocument();
  });

  it("rings the row whose context menu is open", () => {
    useRepo.setState({
      changes: { staged: [], unstaged: [staged("src/a.ts")], conflicted: [], advanced: emptyAdvancedState },
      selectedFile: { path: "src/a.ts", source: "unstaged" },
    });
    render(<WorkingInspector onOpenChanges={() => {}} />);
    const row = screen.getByText("a.ts").closest("button")!;
    // `ring-1` is unique to the menu-target highlight (focusRing uses ring-2).
    expect(row.className).not.toMatch(/ring-1\b/);
    fireEvent.contextMenu(screen.getByText("a.ts"));
    expect(screen.getByText("a.ts").closest("button")!.className).toMatch(/ring-1\b/);
  });
});

describe("FileContextMenu", () => {
  it("labels the discard item 'Discard changes' for an unstaged file", () => {
    useUi.setState({ fileMenu: { x: 10, y: 10, path: "src/a.ts", discard: { staged: false } } });
    render(<FileContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Discard changes" })).toBeInTheDocument();
    // Copy variants lead the menu, flat (most-used here).
    expect(screen.getByRole("menuitem", { name: "Full path" })).toBeInTheDocument();
    // History views are tucked into the History group.
    fireEvent.click(screen.getByRole("menuitem", { name: "History" }));
    expect(screen.getByRole("menuitem", { name: "File history" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Blame" })).toBeInTheDocument();
  });

  it("adapts the discard label to 'Unstage & discard changes' for a staged file", () => {
    useUi.setState({ fileMenu: { x: 10, y: 10, path: "src/a.ts", discard: { staged: true } } });
    render(<FileContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Unstage & discard changes" })).toBeInTheDocument();
  });

  it("disables discard for a guarded working file", () => {
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [staged("docs/hidden.txt")],
        conflicted: [],
        advanced: {
          submodules: [],
          lfs: { detected: false, installed: null, issues: [], patterns: [] },
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["/*", "!/*/", "/src/"] },
        },
      },
    });
    useUi.setState({ fileMenu: { x: 10, y: 10, path: "docs/hidden.txt", discard: { staged: false } } });
    render(<FileContextMenu />);

    const discard = screen.getByRole("menuitem", { name: "Discard changes" });
    expect(discard).toBeDisabled();
    expect(screen.getByText("Outside sparse checkout. Expand the sparse checkout or use git add --sparse.")).toBeInTheDocument();
  });

  it("omits the discard item for a committed file (copy-only menu)", () => {
    useUi.setState({ fileMenu: { x: 10, y: 10, path: "src/a.ts" } });
    render(<FileContextMenu />);
    expect(screen.queryByRole("menuitem", { name: /discard/i })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Full path" })).toBeInTheDocument();
  });

  it("opens file history and blame from the context menu", () => {
    const openFileHistory = vi.fn(async () => {});
    useRepo.setState({ openFileHistory });
    useUi.setState({ fileMenu: { x: 10, y: 10, path: "src/a.ts" } });
    const first = render(<FileContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "History" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "File history" }));
    expect(openFileHistory).toHaveBeenCalledWith("src/a.ts");
    first.unmount();

    useUi.setState({ fileMenu: { x: 10, y: 10, path: "src/a.ts" } });
    render(<FileContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "History" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Blame" }));
    expect(openFileHistory).toHaveBeenCalledWith("src/a.ts", "blame");
  });
});

// The header exposes a whole-tree "Discard all" beside "review all →", reusing
// the WIP menu's preview → confirm → run flow so the destructive path is shared.
describe("WorkingInspector — discard all", () => {
  const preview: DiscardAllPreview = {
    summary: "Discards 1 file",
    details: [],
    warnings: [],
    expectedState: "discard-all-state-v1",
    expectedHeadBranch: "main",
    expectedHeadOid: "c1",
  };

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "preview_discard_all") return Promise.resolve(preview);
      if (cmd === "discard_all") return Promise.resolve("Discarded all changes.");
      return Promise.resolve(null);
    });
    useRepo.setState({
      summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
    });
  });

  it("previews and, on confirm, discards the whole working tree", async () => {
    const requestConfirm = vi.fn();
    useUi.setState({ requestConfirm });
    useRepo.setState({
      changes: { staged: [], unstaged: [staged("src/a.ts")], conflicted: [], advanced: emptyAdvancedState },
      selectedFile: { path: "src/a.ts", source: "unstaged" },
    });

    render(<WorkingInspector onOpenChanges={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard all changes" }));

    await waitFor(() => expect(requestConfirm).toHaveBeenCalledTimes(1));
    const req = requestConfirm.mock.calls[0][0];
    expect(req).toMatchObject({ confirmLabel: "Discard all", danger: true });
    expect(invokeMock).toHaveBeenCalledWith("preview_discard_all", { path: "/r" });
    expect(invokeMock).not.toHaveBeenCalledWith("discard_all", expect.anything());

    act(() => req.onConfirm());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("discard_all", {
      path: "/r",
      expectedState: "discard-all-state-v1",
      expectedHeadBranch: "main",
      expectedHeadOid: "c1",
    }));
  });

  it("hides Discard all when the working tree is clean", () => {
    useUi.setState({ requestConfirm: vi.fn() });
    useRepo.setState({
      changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
      selectedFile: null,
    });
    render(<WorkingInspector onOpenChanges={() => {}} />);
    expect(screen.queryByRole("button", { name: "Discard all changes" })).not.toBeInTheDocument();
  });

  it("does not discard when the confirmation is dismissed", async () => {
    const requestConfirm = vi.fn();
    useUi.setState({ requestConfirm });
    useRepo.setState({
      changes: { staged: [], unstaged: [staged("src/a.ts")], conflicted: [], advanced: emptyAdvancedState },
      selectedFile: { path: "src/a.ts", source: "unstaged" },
    });

    render(<WorkingInspector onOpenChanges={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard all changes" }));

    // The preview opens the confirm, but dismissing it (never calling onConfirm)
    // must leave the irreversible discard un-run.
    await waitFor(() => expect(requestConfirm).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith("preview_discard_all", { path: "/r" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(invokeMock).not.toHaveBeenCalledWith("discard_all", expect.anything());
  });

  it("disables Discard all when a bulk write is guarded", () => {
    const requestConfirm = vi.fn();
    useUi.setState({ requestConfirm });
    // Ordinary writes are allowed for this in-cone path, but whole-tree discard
    // cannot safely preserve the repository's skip-worktree entries.
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [staged("src/a.ts")],
        conflicted: [],
        advanced: {
          submodules: [],
          lfs: { detected: false, installed: null, issues: [], patterns: [] },
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["src/"] },
        },
      },
      selectedFile: { path: "src/a.ts", source: "unstaged" },
    });

    render(<WorkingInspector onOpenChanges={() => {}} />);
    const button = screen.getByRole("button", { name: "Discard all changes" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Sparse checkout is enabled. Disable sparse checkout before using Discard all, or use the terminal.",
    );

    fireEvent.click(button);
    expect(invokeMock).not.toHaveBeenCalledWith("preview_discard_all", expect.anything());
    expect(requestConfirm).not.toHaveBeenCalled();
  });

  it("disables Discard all before the first commit", () => {
    const requestConfirm = vi.fn();
    useUi.setState({ requestConfirm });
    useRepo.setState({
      summary: {
        path: "/r",
        workdir: "/r",
        headBranch: "main",
        headOid: null,
        detached: false,
        unborn: true,
      },
      changes: {
        staged: [staged("first.txt")],
        unstaged: [],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
      selectedFile: { path: "first.txt", source: "staged" },
    });

    render(<WorkingInspector onOpenChanges={() => {}} />);
    const button = screen.getByRole("button", { name: "Discard all changes" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Discard all is unavailable before the first commit. Unstage or remove files individually, or use the terminal.",
    );
    expect(invokeMock).not.toHaveBeenCalledWith("preview_discard_all", expect.anything());
  });
});
