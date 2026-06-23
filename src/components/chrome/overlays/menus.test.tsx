import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRepo } from "../../../store/repo";
import { useUi } from "../../../store/ui";
import { BranchRow } from "../../navigation/branch-navigator/rows";
import { TagContextMenu, WipContextMenu, WorktreeContextMenu } from "./menus";

beforeEach(() => {
  useRepo.setState({ changes: { staged: [], unstaged: [] } });
  useUi.setState({
    wipMenu: null,
    tagMenu: null,
    worktreeMenu: null,
    prompt: null,
    createBranchOpen: false,
    createBranchStart: null,
  });
});

const file = (path: string) => ({ path, status: "M" as const, add: 1, del: 0 });

describe("WipContextMenu", () => {
  it("renders nothing until a wip menu is open", () => {
    const { container } = render(<WipContextMenu />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers Commit, Stash, and Discard but hides stage/unstage when the tree is clean", () => {
    useUi.setState({ wipMenu: { x: 10, y: 10 } });
    render(<WipContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Commit…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Stash all changes" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Discard all changes" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Stage all changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Unstage all changes" })).not.toBeInTheDocument();
  });

  it("shows Stage all only when there are unstaged files", () => {
    useRepo.setState({ changes: { staged: [], unstaged: [file("a.ts")] } });
    useUi.setState({ wipMenu: { x: 10, y: 10 } });
    render(<WipContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Stage all changes" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Unstage all changes" })).not.toBeInTheDocument();
  });

  it("shows Unstage all only when there are staged files", () => {
    useRepo.setState({ changes: { staged: [file("b.ts")], unstaged: [] } });
    useUi.setState({ wipMenu: { x: 10, y: 10 } });
    render(<WipContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Unstage all changes" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Stage all changes" })).not.toBeInTheDocument();
  });
});

describe("TagContextMenu", () => {
  it("offers checkout / branch / worktree / push / delete / copy for a tag", () => {
    useUi.setState({ tagMenu: { x: 10, y: 10, name: "v1.0.0", sha: "abc1234" } });
    render(<TagContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Checkout tag (detached)" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Create branch from here…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Create worktree from tag…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Push tag to origin" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete tag" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy tag name" })).toBeInTheDocument();
  });

  // A branch and a tag can share a short name, so the operations must reference
  // the peeled commit sha — never the ambiguous tag name.
  it("uses the tag sha (not its name) as the create-branch start point", () => {
    useUi.setState({ tagMenu: { x: 10, y: 10, name: "v1.0.0", sha: "abc1234deadbeef" } });
    render(<TagContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Create branch from here…" }));
    expect(useUi.getState().createBranchStart).toBe("abc1234deadbeef");
    expect(useUi.getState().createBranchOpen).toBe(true);
  });

  it("uses the tag sha (not its name) as the create-worktree reference", async () => {
    const createWorktreeAt = vi.fn().mockResolvedValue("created");
    useRepo.setState({ createWorktreeAt });
    useUi.setState({ tagMenu: { x: 10, y: 10, name: "v1.0.0", sha: "abc1234deadbeef" } });
    render(<TagContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Create worktree from tag…" }));
    const prompt = useUi.getState().prompt;
    expect(prompt).not.toBeNull();
    // The prompt's default path still reflects the readable tag name as a label.
    expect(prompt?.title).toContain("v1.0.0");
    prompt!.onSubmit("/work/wt");
    await waitFor(() =>
      expect(createWorktreeAt).toHaveBeenCalledWith("/work/wt", "abc1234deadbeef"),
    );
  });
});

describe("navigator tag row", () => {
  it("opens the tag menu carrying the tagged commit sha", () => {
    render(<BranchRow name="v2.3.4" kind="tag" oid="deadbeefcafe" />);
    fireEvent.contextMenu(screen.getByText("v2.3.4"));
    const menu = useUi.getState().tagMenu;
    expect(menu?.name).toBe("v2.3.4");
    expect(menu?.sha).toBe("deadbeefcafe");
  });
});

describe("WorktreeContextMenu", () => {
  it("offers open / copy-path / remove for a linked worktree", () => {
    useUi.setState({ worktreeMenu: { x: 10, y: 10, path: "/work/repo-wt", name: "feature", isMain: false } });
    render(<WorktreeContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Open worktree" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remove worktree" })).toBeInTheDocument();
  });

  it("hides Remove for the main worktree", () => {
    useUi.setState({ worktreeMenu: { x: 10, y: 10, path: "/work/repo", name: "main", isMain: true } });
    render(<WorktreeContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Open worktree" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remove worktree" })).not.toBeInTheDocument();
  });
});
