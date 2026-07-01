import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FileChange } from "../../lib/api";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { FileContextMenu } from "../../components/chrome/overlays";
import { WorkingInspector } from "./WorkingInspector";

const staged = (path: string): FileChange => ({ path, status: "M", add: 1, del: 0, binary: false });

beforeEach(() => {
  // Reset the git-domain slice this component reads to a clean, empty tree.
  useRepo.setState({ changes: { staged: [], unstaged: [], conflicted: [] }, selectedFile: null });
  useUi.setState({ fileMenu: null });
});

describe("WorkingInspector", () => {
  it("shows the empty state when there are no changes", () => {
    render(<WorkingInspector onOpenChanges={() => {}} />);
    expect(screen.getByRole("heading", { name: /0 changes on/i })).toBeInTheDocument();
    // Both the Unstaged and Staged sections render their "No files." placeholder.
    expect(screen.getAllByText("No files.")).toHaveLength(2);
  });

  it("disables 'Start commit' when nothing is staged", () => {
    render(<WorkingInspector onOpenChanges={() => {}} />);
    expect(screen.getByRole("button", { name: "Start commit" })).toBeDisabled();
  });

  it("enables 'Start commit' once something is staged", () => {
    // selectedFile already points at the staged file, so the keep-selection
    // effect is a no-op (no async selectFile → no IPC needed here).
    useRepo.setState({
      changes: { staged: [staged("a.ts")], unstaged: [], conflicted: [] },
      selectedFile: { path: "a.ts", source: "staged" },
    });
    render(<WorkingInspector onOpenChanges={() => {}} />);
    expect(screen.getByRole("button", { name: "Start commit" })).toBeEnabled();
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
      changes: { staged: [], unstaged: [staged("src/a.ts")], conflicted: [] },
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
      changes: { staged: [staged("src/b.ts")], unstaged: [], conflicted: [] },
      selectedFile: { path: "src/b.ts", source: "staged" },
    });
    render(<WorkingInspector onOpenChanges={() => {}} />);
    fireEvent.contextMenu(screen.getByText("b.ts"));
    expect(useUi.getState().fileMenu?.discard?.staged).toBe(true);
  });

  it("omits discard (copy-only) when right-clicking a renamed file", () => {
    // A rename's FileChange carries only the new path, so discard would half-undo
    // it — the menu opens copy-only (no discard target).
    useRepo.setState({
      changes: { staged: [{ path: "src/new.ts", status: "R", add: 0, del: 0, binary: false }], unstaged: [], conflicted: [] },
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
      changes: { staged: [], unstaged: [staged("src/a.ts"), staged("src/b.ts")], conflicted: [] },
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

  it("rings the row whose context menu is open", () => {
    useRepo.setState({
      changes: { staged: [], unstaged: [staged("src/a.ts")], conflicted: [] },
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
