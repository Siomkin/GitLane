import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { FileChange } from "../../lib/api";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { FileContextMenu } from "../../components/chrome/overlays";
import { WorkingInspector } from "./WorkingInspector";

const staged = (path: string): FileChange => ({ path, status: "M", add: 1, del: 0 });

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
      changes: { staged: [{ path: "src/new.ts", status: "R", add: 0, del: 0 }], unstaged: [], conflicted: [] },
      selectedFile: { path: "src/new.ts", source: "staged" },
    });
    render(<WorkingInspector onOpenChanges={() => {}} />);
    fireEvent.contextMenu(screen.getByText("new.ts"));
    const menu = useUi.getState().fileMenu;
    expect(menu?.path).toBe("src/new.ts");
    expect(menu?.discard).toBeUndefined();
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
    expect(screen.getByRole("menuitem", { name: "Copy full path" })).toBeInTheDocument();
  });

  it("adapts the discard label to 'Unstage & discard changes' for a staged file", () => {
    useUi.setState({ fileMenu: { x: 10, y: 10, path: "src/a.ts", discard: { staged: true } } });
    render(<FileContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Unstage & discard changes" })).toBeInTheDocument();
  });

  it("omits the discard item for a committed file (copy-only menu)", () => {
    useUi.setState({ fileMenu: { x: 10, y: 10, path: "src/a.ts" } });
    render(<FileContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Copy full path" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /discard/i })).not.toBeInTheDocument();
  });
});
