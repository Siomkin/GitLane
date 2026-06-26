import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRepo } from "../../../store/repo";
import { useUi } from "../../../store/ui";
import { BranchRow } from "../../navigation/branch-navigator/rows";
import { BranchContextMenu, TagContextMenu, WipContextMenu, WorktreeContextMenu } from "./menus";

// BranchContextMenu probes `api.canFastForward` (→ invoke) from an effect when a
// branch other than HEAD is selected, so the IPC boundary must be mocked. Reject
// any other command so a stray invoke fails loudly instead of silently resolving.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// Captured before any test mutates store actions, so beforeEach can restore the
// real actions after a test swaps in a spy (Zustand setState merges, so a mocked
// action would otherwise leak into later tests — and into later test files, since
// the store is a shared singleton with no global reset).
const realRemoveBranch = useRepo.getState().removeBranch;
const realCreateWorktreeAt = useRepo.getState().createWorktreeAt;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) =>
    cmd === "can_fast_forward"
      ? Promise.resolve(false)
      : Promise.reject(new Error(`unexpected invoke: ${cmd}`)),
  );
  useRepo.setState({
    changes: { staged: [], unstaged: [], conflicted: [] },
    summary: null,
    branches: [],
    worktrees: [],
    removeBranch: realRemoveBranch,
    createWorktreeAt: realCreateWorktreeAt,
  });
  useUi.setState({
    wipMenu: null,
    tagMenu: null,
    worktreeMenu: null,
    contextMenu: null,
    confirm: null,
    prompt: null,
    createBranchOpen: false,
    createBranchStart: null,
  });
});

const localBranch = (name: string) => ({
  name,
  kind: "local" as const,
  target: "abc1234",
  isHead: false,
  upstream: null,
});

const remoteBranch = (name: string) => ({
  name,
  kind: "remote" as const,
  target: "abc1234",
  isHead: false,
  upstream: null,
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
    useRepo.setState({ changes: { staged: [], unstaged: [file("a.ts")], conflicted: [] } });
    useUi.setState({ wipMenu: { x: 10, y: 10 } });
    render(<WipContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Stage all changes" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Unstage all changes" })).not.toBeInTheDocument();
  });

  it("shows Unstage all only when there are staged files", () => {
    useRepo.setState({ changes: { staged: [file("b.ts")], unstaged: [], conflicted: [] } });
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

describe("BranchContextMenu", () => {
  it("renders nothing until a branch menu is open", () => {
    const { container } = render(<BranchContextMenu />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers Delete for a local non-current branch", () => {
    useRepo.setState({ branches: [localBranch("feature")] });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Delete feature" })).toBeInTheDocument();
  });

  it("hides Delete for the current branch", () => {
    useRepo.setState({ branches: [localBranch("feature")] });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: true } });
    render(<BranchContextMenu />);
    expect(screen.queryByRole("menuitem", { name: "Delete feature" })).not.toBeInTheDocument();
  });

  // `git branch -D` refuses a branch checked out in a linked worktree, so the
  // menu must not offer Delete there — it would only produce a git error toast.
  it("hides Delete when the branch is checked out in another worktree", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
      worktrees: [{ name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false }],
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);
    expect(screen.queryByRole("menuitem", { name: "Delete feature" })).not.toBeInTheDocument();
    // Checkout is gated the same way — proves Delete now has parity with it.
    expect(screen.queryByRole("menuitem", { name: "Checkout feature" })).not.toBeInTheDocument();
    // ...but the worktree's own "Open worktree" entry is still offered.
    expect(screen.getByRole("menuitem", { name: "Open worktree" })).toBeInTheDocument();
    // Rename stays available on purpose: `git branch -m` renames a branch checked
    // out in another worktree fine (it updates that worktree's HEAD); only `-D` is
    // refused. So the Delete/Rename gating asymmetry is intentional, not a bug.
    expect(screen.getByRole("menuitem", { name: "Rename feature…" })).toBeInTheDocument();
  });

  // Remote-tracking refs reach the same menu; local-only mutations like Delete
  // are gated on `isLocal` and must not appear.
  it("hides the local Delete for a remote-tracking ref", () => {
    useRepo.setState({ branches: [remoteBranch("origin/feature")] });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "origin/feature", isCurrent: false } });
    render(<BranchContextMenu />);
    expect(screen.queryByRole("menuitem", { name: "Delete origin/feature" })).not.toBeInTheDocument();
    // The remote-delete item is a different action and must remain available.
    expect(screen.getByRole("menuitem", { name: "Delete origin/feature on remote" })).toBeInTheDocument();
  });

  // The bug this fixed (GL-33): the confirm must force-delete (`-D`) so unmerged
  // branches actually delete, matching the dialog's "Unmerged commits may be lost".
  it("force-deletes on confirm (passes force=true to removeBranch)", async () => {
    const removeBranch = vi.fn().mockResolvedValue("Deleted feature");
    useRepo.setState({ branches: [localBranch("feature")], removeBranch });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete feature" }));
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    confirm!.onConfirm();
    await waitFor(() => expect(removeBranch).toHaveBeenCalledWith("feature", true));
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

  it("hides Remove for the linked worktree backing the open repo", () => {
    // App opened on a linked worktree: isMain is false, but removing it would
    // delete the active tab's directory, so the path match must suppress it.
    useRepo.setState({
      summary: {
        path: "/work/repo-wt",
        workdir: "/work/repo-wt",
        headBranch: "feature",
        headOid: null,
        detached: false,
      },
    });
    useUi.setState({ worktreeMenu: { x: 10, y: 10, path: "/work/repo-wt/", name: "feature", isMain: false } });
    render(<WorktreeContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Open worktree" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remove worktree" })).not.toBeInTheDocument();
  });
});
