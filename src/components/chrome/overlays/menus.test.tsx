import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useRepo } from "../../../store/repo";
import { useUi } from "../../../store/ui";
import { TagContextMenu, WipContextMenu, WorktreeContextMenu } from "./menus";

beforeEach(() => {
  useRepo.setState({ changes: { staged: [], unstaged: [] } });
  useUi.setState({ wipMenu: null, tagMenu: null, worktreeMenu: null });
});

const file = (path: string) => ({ path, status: "M" as const, add: 1, del: 0 });

describe("WipContextMenu", () => {
  it("renders nothing until a wip menu is open", () => {
    const { container } = render(<WipContextMenu />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers Commit and Stash but hides stage/unstage when the tree is clean", () => {
    useUi.setState({ wipMenu: { x: 10, y: 10 } });
    render(<WipContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Commit…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Stash all changes" })).toBeInTheDocument();
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
  it("offers checkout / branch / worktree / copy for a tag", () => {
    useUi.setState({ tagMenu: { x: 10, y: 10, name: "v1.0.0", sha: "abc1234" } });
    render(<TagContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Checkout tag (detached)" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Create branch from here…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Create worktree from tag…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy tag name" })).toBeInTheDocument();
  });
});

describe("WorktreeContextMenu", () => {
  it("offers open and copy-path for a worktree", () => {
    useUi.setState({ worktreeMenu: { x: 10, y: 10, path: "/work/repo-wt", name: "feature" } });
    render(<WorktreeContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Open worktree" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
  });
});
