import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRepo } from "../../../store/repo";
import { useUi } from "../../../store/ui";
import { BranchRow } from "../../navigation/branch-navigator/rows";
import { ActionMenu, BranchContextMenu, TagContextMenu, WipContextMenu, WorktreeContextMenu } from "./menus";

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
const realPublishBranch = useRepo.getState().publishBranch;
const realMoveBranchToWorktree = useRepo.getState().moveBranchToWorktree;
const realDeleteBranchWithWorktree = useRepo.getState().deleteBranchWithWorktree;
const realRemoveWorktree = useRepo.getState().removeWorktree;
const realOpenWorktree = useRepo.getState().openWorktree;
const realOpenCompare = useRepo.getState().openCompare;
const realCheckoutBranch = useRepo.getState().checkoutBranch;
const realRebaseOnto = useRepo.getState().rebaseOnto;
const realResetCurrentTo = useRepo.getState().resetCurrentTo;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "can_fast_forward") return Promise.resolve(false);
    if (cmd.startsWith("preview_")) {
      return Promise.resolve({ summary: "Impact summary", details: ["Affected path"], warnings: ["Recovery warning"] });
    }
    return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
  });
  useRepo.setState({
    changes: { staged: [], unstaged: [], conflicted: [] },
    summary: null,
    branches: [],
    worktrees: [],
    removeBranch: realRemoveBranch,
    createWorktreeAt: realCreateWorktreeAt,
    publishBranch: realPublishBranch,
    moveBranchToWorktree: realMoveBranchToWorktree,
    deleteBranchWithWorktree: realDeleteBranchWithWorktree,
    removeWorktree: realRemoveWorktree,
    openWorktree: realOpenWorktree,
    openCompare: realOpenCompare,
    checkoutBranch: realCheckoutBranch,
    rebaseOnto: realRebaseOnto,
    resetCurrentTo: realResetCurrentTo,
  });
  useUi.setState({
    wipMenu: null,
    tagMenu: null,
    worktreeMenu: null,
    contextMenu: null,
    actionMenu: null,
    confirm: null,
    prompt: null,
    toast: null,
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

const file = (path: string) => ({ path, status: "M" as const, add: 1, del: 0, binary: false });

// Grouped menus tuck many actions into accordion rows; open one by clicking its
// parent, then its children render inline. Single-open: opening one collapses
// any other.
const openGroup = (name: string) => fireEvent.click(screen.getByRole("menuitem", { name }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

  it("disables guarded bulk actions", () => {
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [
          {
            ...file("deps/child"),
            advanced: { kind: "submodule", message: "Submodule: modified files inside submodule" },
          },
        ],
        conflicted: [],
      },
    });
    useUi.setState({ wipMenu: { x: 10, y: 10 } });
    render(<WipContextMenu />);

    expect(screen.getByRole("menuitem", { name: "Stage all changes" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Stash all changes" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Discard all changes" })).toBeDisabled();
    expect(screen.getAllByText("Submodule: modified files inside submodule. Use the terminal for submodule updates.")).toHaveLength(3);
  });

  it("shows Unstage all only when there are staged files", () => {
    useRepo.setState({ changes: { staged: [file("b.ts")], unstaged: [], conflicted: [] } });
    useUi.setState({ wipMenu: { x: 10, y: 10 } });
    render(<WipContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Unstage all changes" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Stage all changes" })).not.toBeInTheDocument();
  });

  it("closes the menu while a destructive preview is still pending", async () => {
    const pending = deferred<{
      summary: string;
      details: string[];
      warnings: string[];
    }>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "preview_discard_all") return pending.promise;
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "head", detached: false },
      changes: { staged: [file("b.ts")], unstaged: [], conflicted: [] },
    });
    useUi.setState({ wipMenu: { x: 10, y: 10 } });
    render(<WipContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Discard all changes" }));

    await waitFor(() => expect(useUi.getState().wipMenu).toBeNull());
    expect(useUi.getState().confirm).toBeNull();

    pending.resolve({ summary: "Impact summary", details: ["Affected path"], warnings: [] });
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
  });
});

describe("TagContextMenu", () => {
  it("offers checkout / push / create / copy / delete for a tag", () => {
    useUi.setState({ tagMenu: { x: 10, y: 10, name: "v1.0.0", sha: "abc1234" } });
    render(<TagContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Checkout tag (detached)" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Push tag to origin" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy tag name" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete local tag" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete from local and origin" }),
    ).toBeInTheDocument();
    openGroup("Create");
    expect(screen.getByRole("menuitem", { name: "Branch from here…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Worktree from tag…" })).toBeInTheDocument();
  });

  it("routes the everywhere-delete through deleteTag(name, true) after confirm", async () => {
    const deleteTag = vi.fn().mockResolvedValue("Deleted tag v1.0.0 (local and origin)");
    useRepo.setState({ deleteTag });
    useUi.setState({ tagMenu: { x: 10, y: 10, name: "v1.0.0", sha: "abc1234" } });
    render(<TagContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete from local and origin" }));
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    confirm!.onConfirm();
    await waitFor(() => expect(deleteTag).toHaveBeenCalledWith("v1.0.0", true));
  });

  // A branch and a tag can share a short name, so the operations must reference
  // the peeled commit sha — never the ambiguous tag name.
  it("uses the tag sha (not its name) as the create-branch start point", () => {
    useUi.setState({ tagMenu: { x: 10, y: 10, name: "v1.0.0", sha: "abc1234deadbeef" } });
    render(<TagContextMenu />);
    openGroup("Create");
    fireEvent.click(screen.getByRole("menuitem", { name: "Branch from here…" }));
    expect(useUi.getState().createBranchStart).toBe("abc1234deadbeef");
    expect(useUi.getState().createBranchOpen).toBe(true);
  });

  it("uses the tag sha (not its name) as the create-worktree reference", async () => {
    const createWorktreeAt = vi.fn().mockResolvedValue("created");
    useRepo.setState({ createWorktreeAt });
    useUi.setState({ tagMenu: { x: 10, y: 10, name: "v1.0.0", sha: "abc1234deadbeef" } });
    render(<TagContextMenu />);
    openGroup("Create");
    fireEvent.click(screen.getByRole("menuitem", { name: "Worktree from tag…" }));
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

describe("navigator branch row", () => {
  it("marks a branch checked out in a worktree with the worktree glyph + tooltip", () => {
    render(<BranchRow name="feature" kind="local" oid="c1" worktree="repo-feature" />);
    expect(screen.getByLabelText("Checked out in worktree repo-feature")).toBeInTheDocument();
  });

  it("shows no worktree marker for an ordinary branch", () => {
    render(<BranchRow name="feature" kind="local" oid="c1" />);
    expect(screen.queryByLabelText(/Checked out in worktree/)).not.toBeInTheDocument();
  });
});

describe("BranchContextMenu", () => {
  it("renders nothing until a branch menu is open", () => {
    const { container } = render(<BranchContextMenu />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers Delete (inside Danger zone) for a local non-current branch", () => {
    useRepo.setState({ branches: [localBranch("feature")] });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);
    openGroup("Danger zone");
    expect(screen.getByRole("menuitem", { name: "Delete feature" })).toBeInTheDocument();
  });

  it("groups actions behind collapsed accordion rows that open one at a time", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);

    // Groups start collapsed — children aren't in the DOM yet.
    expect(screen.getByRole("menuitem", { name: "Compare" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menuitem", { name: "Merge feature" })).not.toBeInTheDocument();

    openGroup("Integrate into current");
    expect(screen.getByRole("menuitem", { name: "Merge feature" })).toBeInTheDocument();

    // Single-open: opening Compare collapses Integrate.
    openGroup("Compare");
    expect(screen.queryByRole("menuitem", { name: "Merge feature" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Compare with branch…" })).toBeInTheDocument();
  });

  it("compare-with-branch opens a branch picker (not a free-text field) and compares against the picked branch", async () => {
    const openCompare = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("main"), localBranch("feature"), localBranch("develop"), remoteBranch("origin/main")],
      openCompare,
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);

    openGroup("Compare");
    fireEvent.click(screen.getByRole("menuitem", { name: "Compare with branch…" }));

    const prompt = useUi.getState().prompt;
    expect(prompt).not.toBeNull();
    // It's a picker now: options are present and the head branch is excluded.
    const values = prompt?.options?.map((o) => o.value);
    expect(values).toEqual(["main", "develop", "origin/main"]);
    expect(values).not.toContain("feature");
    // Current branch is flagged and pre-highlighted via defaultValue.
    expect(prompt?.options?.find((o) => o.value === "main")?.hint).toBe("current");
    expect(prompt?.options?.find((o) => o.value === "origin/main")?.hint).toBe("remote");
    expect(prompt?.defaultValue).toBe("main");

    prompt!.onSubmit("develop");
    await waitFor(() =>
      expect(openCompare).toHaveBeenCalledWith(
        expect.objectContaining({ base: "develop", head: "feature", scope: "branch" }),
      ),
    );
  });

  it("hides Delete for the current branch", () => {
    useRepo.setState({ branches: [localBranch("feature")] });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: true } });
    render(<BranchContextMenu />);
    openGroup("Danger zone");
    expect(screen.queryByRole("menuitem", { name: "Delete feature" })).not.toBeInTheDocument();
  });

  it("opens the publish prompt for a non-current branch without an upstream", async () => {
    const publishBranch = vi.fn().mockResolvedValue("Published feature to origin/feature");
    const pushBranch = vi.fn().mockResolvedValue("Pushed feature");
    useRepo.setState({
      branches: [
        {
          ...localBranch("feature"),
          sync: { status: "noUpstream", upstream: null, ahead: 0, behind: 0 },
        },
      ],
      publishBranch,
      pushBranch,
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });

    render(<BranchContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Push feature" }));

    const prompt = useUi.getState().prompt;
    expect(prompt).not.toBeNull();
    expect(prompt?.title).toBe("Publish feature");
    expect(prompt?.defaultValue).toBe("origin/feature");
    prompt!.onSubmit("origin/feature");

    await waitFor(() => expect(publishBranch).toHaveBeenCalledWith("feature", "origin/feature"));
    expect(pushBranch).not.toHaveBeenCalled();
  });

  it("opens the publish prompt for the current branch without an upstream", async () => {
    const publishBranch = vi.fn().mockResolvedValue("Published main to origin/main");
    const push = vi.fn().mockResolvedValue("Pushed current branch");
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [
        {
          ...localBranch("main"),
          isHead: true,
          sync: { status: "noUpstream", upstream: null, ahead: 0, behind: 0 },
        },
      ],
      publishBranch,
      push,
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "main", isCurrent: true } });

    render(<BranchContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Push" }));

    const prompt = useUi.getState().prompt;
    expect(prompt).not.toBeNull();
    expect(prompt?.title).toBe("Publish main");
    expect(prompt?.defaultValue).toBe("origin/main");
    prompt!.onSubmit("origin/main");

    await waitFor(() => expect(publishBranch).toHaveBeenCalledWith("main", "origin/main"));
    expect(push).not.toHaveBeenCalled();
  });

  it("pre-fills a fresh publish target for a stale upstream, not the pruned ref", () => {
    const publishBranch = vi.fn().mockResolvedValue("published");
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [
        {
          ...localBranch("main"),
          isHead: true,
          upstream: "origin/deleted",
          sync: { status: "staleUpstream", upstream: "origin/deleted", ahead: 0, behind: 0 },
        },
      ],
      publishBranch,
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "main", isCurrent: true } });

    render(<BranchContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Push" }));

    const prompt = useUi.getState().prompt;
    expect(prompt?.title).toBe("Publish main");
    expect(prompt?.defaultValue).toBe("origin/main");
  });

  // `git branch -D` refuses a branch checked out in a linked worktree. Rather
  // than a two-step (remove worktree, then delete), the menu offers one combined
  // action; the plain disabled Delete is gone for the linked-worktree case.
  it("promotes Open worktree + offers Hand off / Remove under Worktree for a linked worktree", () => {
    const moveBranchToWorktree = vi.fn().mockResolvedValue("Handed off feature to repo");
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
      worktrees: [
        { name: "repo", path: "/work/repo", branch: "main", isMain: true },
        { name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false },
      ],
      moveBranchToWorktree,
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);
    // Open worktree is promoted to the top.
    expect(screen.getByRole("menuitem", { name: "Open worktree" })).toBeInTheDocument();
    // Checkout stays hidden: offering it would only produce a git worktree error.
    expect(screen.queryByRole("menuitem", { name: "Checkout feature" })).not.toBeInTheDocument();
    // Worktree group holds the hand-off + remove actions.
    openGroup("Worktree");
    expect(screen.getByRole("menuitem", { name: "Remove worktree" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Hand off to…" }));
    // The picker opens with the branch's *other* worktrees as destinations (the
    // source worktree is filtered out), then a detach confirm runs the move.
    const prompt = useUi.getState().prompt;
    expect(prompt?.title).toBe("Hand off feature to…");
    expect(prompt?.options?.map((o) => o.value)).toEqual(["/work/repo"]);
    prompt!.onSubmit("/work/repo");
    const confirm = useUi.getState().confirm;
    expect(confirm?.title).toBe("Hand off feature to main?");
    confirm!.onConfirm();
    expect(moveBranchToWorktree).toHaveBeenCalledWith("feature", "/work/repo-feature", "/work/repo", true);
  });

  // "Hand off to…" is hidden when no *valid* destination exists — the only other
  // worktree here is the bare main repo, which can't receive a checkout.
  it("hides Hand off when the only other worktree is bare", () => {
    useRepo.setState({
      summary: { path: "/work/bare.git", workdir: "/work/bare.git", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
      worktrees: [
        { name: "bare.git", path: "/work/bare.git", branch: null, isMain: true, bare: true },
        { name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false },
      ],
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);
    openGroup("Worktree");
    expect(screen.queryByRole("menuitem", { name: "Hand off to…" })).not.toBeInTheDocument();
  });

  // The combined action previews the delete (so unmerged commits are surfaced),
  // then on confirm removes the worktree and deletes the branch in one step.
  it("previews then removes the worktree and deletes the branch on confirm", async () => {
    const deleteBranchWithWorktree = vi.fn().mockResolvedValue("Deleted feature and its worktree");
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "head", detached: false },
      branches: [localBranch("feature")],
      worktrees: [{ name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false }],
      deleteBranchWithWorktree,
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);

    openGroup("Danger zone");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete feature & worktree…" }));
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
    expect(invokeMock).toHaveBeenCalledWith(
      "preview_delete_branch",
      expect.objectContaining({ branch: "feature" }),
    );
    expect(useUi.getState().confirm?.warnings).toContain("Recovery warning");
    useUi.getState().confirm!.onConfirm();
    await waitFor(() =>
      expect(deleteBranchWithWorktree).toHaveBeenCalledWith("feature", "/work/repo-feature"),
    );
  });

  // "Remove worktree" (in the Worktree group) keeps the branch — it only removes
  // the worktree dir (the keep-the-branch counterpart to the combined delete).
  it("removes only the worktree (keeping the branch) on confirm", () => {
    const removeWorktree = vi.fn().mockResolvedValue("Removed worktree");
    const deleteBranchWithWorktree = vi.fn().mockResolvedValue("Deleted feature and its worktree");
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
      worktrees: [{ name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false }],
      removeWorktree,
      deleteBranchWithWorktree,
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);

    openGroup("Worktree");
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }));
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    confirm!.onConfirm();
    // Unlocked worktree → unforced removal (git's dirty check still applies).
    expect(removeWorktree).toHaveBeenCalledWith("/work/repo-feature", false);
    // The branch is untouched — the combined delete must not fire.
    expect(deleteBranchWithWorktree).not.toHaveBeenCalled();
  });

  // A locked worktree needs a forced removal (`--force --force` on the backend);
  // the confirm surfaces the lock and the call forces it.
  it("forces removal of a locked worktree and warns in the confirm", () => {
    const removeWorktree = vi.fn().mockResolvedValue("Removed worktree");
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
      worktrees: [{ name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false, locked: true }],
      removeWorktree,
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);

    openGroup("Worktree");
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }));
    const confirm = useUi.getState().confirm;
    expect(confirm?.message).toMatch(/locked/i);
    confirm!.onConfirm();
    expect(removeWorktree).toHaveBeenCalledWith("/work/repo-feature", true);
  });

  // Git refuses to remove the main worktree, so a branch checked out there keeps
  // the plain disabled Delete (with an accurate reason) and no combined action.
  it("disables Delete with no combined action for a main-worktree branch", () => {
    useRepo.setState({
      summary: { path: "/work/wt", workdir: "/work/wt", headBranch: "wt-branch", headOid: null, detached: false },
      branches: [localBranch("feature")],
      worktrees: [{ name: "repo", path: "/work/repo", branch: "feature", isMain: true }],
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);

    openGroup("Danger zone");
    expect(screen.getByRole("menuitem", { name: "Delete feature" })).toBeDisabled();
    expect(screen.getByText("Checked out in the main worktree.")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete feature & worktree…" })).not.toBeInTheDocument();
    // Git can't remove the main worktree, so the Worktree group offers no Remove.
    openGroup("Worktree");
    expect(screen.queryByRole("menuitem", { name: "Remove worktree" })).not.toBeInTheDocument();
    // Opening the main worktree is still fine.
    expect(screen.getByRole("menuitem", { name: "Open worktree" })).toBeInTheDocument();
  });

  // Remote-tracking refs reach the same menu; local-only mutations like Delete
  // are gated on `isLocal` and must not appear.
  it("hides the local Delete for a remote-tracking ref", () => {
    useRepo.setState({ branches: [remoteBranch("origin/feature")] });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "origin/feature", isCurrent: false } });
    render(<BranchContextMenu />);
    openGroup("Danger zone");
    expect(screen.queryByRole("menuitem", { name: "Delete origin/feature" })).not.toBeInTheDocument();
    // The remote-delete item is a different action and must remain available.
    expect(screen.getByRole("menuitem", { name: "Delete origin/feature on remote" })).toBeInTheDocument();
  });

  // The bug this fixed (GL-33): the confirm must force-delete (`-D`) so unmerged
  // branches actually delete, matching the dialog's "Unmerged commits may be lost".
  it("force-deletes on confirm (passes force=true to removeBranch)", async () => {
    const removeBranch = vi.fn().mockResolvedValue("Deleted feature");
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "head", detached: false },
      branches: [localBranch("feature")],
      removeBranch,
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);
    openGroup("Danger zone");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete feature" }));
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    expect(confirm?.details).toContain("Impact summary");
    expect(confirm?.warnings).toContain("Recovery warning");
    confirm!.onConfirm();
    await waitFor(() => expect(removeBranch).toHaveBeenCalledWith("feature", true));
  });

  it("does not open a reset confirmation if HEAD changes while the preview is pending", async () => {
    const pending = deferred<{
      summary: string;
      details: string[];
      warnings: string[];
    }>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "can_fast_forward") return Promise.resolve(false);
      if (cmd === "preview_reset") return pending.promise;
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "old", detached: false },
      branches: [localBranch("feature")],
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);

    openGroup("Danger zone");
    fireEvent.click(screen.getByRole("menuitem", { name: "Mixed — keep changes unstaged" }));
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "other", headOid: "new", detached: false },
    });
    pending.resolve({ summary: "Impact summary", details: ["Affected path"], warnings: [] });

    await waitFor(() =>
      expect(useUi.getState().toast?.message).toContain("HEAD changed"),
    );
    expect(useUi.getState().confirm).toBeNull();
  });
});

// The drag-drop action menu. The drag gesture fixes the direction: a dropped
// local branch moves onto the target — the reverse (moving the target) is never
// offered for a local drag, or the drop would silently move the wrong branch
// (GL-102). A *remote* source can't be mutated, so it instead moves the local
// target. These tests pin the handlers to the direction each label promises,
// which the pure `graphActions` spec test cannot see.
describe("ActionMenu", () => {
  const localSummary = {
    path: "/work/repo",
    workdir: "/work/repo",
    headBranch: "main",
    headOid: "head",
    detached: false,
  };

  const openActionMenu = (fromName: string, toName: string) =>
    useUi.setState({
      actionMenu: {
        x: 10,
        y: 10,
        from: { name: fromName, kind: "local" },
        to: { kind: "local", name: toName },
      },
    });

  it("rebase-source checks out the dragged branch, then rebases it onto the drop target", async () => {
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    const rebaseOnto = vi.fn().mockResolvedValue("Rebased onto main");
    useRepo.setState({
      summary: localSummary,
      branches: [localBranch("feature"), localBranch("main")],
      checkoutBranch,
      rebaseOnto,
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    // The accessible name is prefixed by the icon glyph and suffixed by the
    // `sub` line, so match the label substring rather than anchoring.
    fireEvent.click(screen.getByRole("menuitem", { name: /Rebase feature onto main/ }));

    await waitFor(() => expect(rebaseOnto).toHaveBeenCalledWith("main"));
    expect(checkoutBranch).toHaveBeenCalledWith("feature");
    // The dragged branch moves — the drop target is never checked out or rebased.
    expect(checkoutBranch).not.toHaveBeenCalledWith("main");
    expect(rebaseOnto).not.toHaveBeenCalledWith("feature");
  });

  it("dragging a local branch onto a local branch never offers the reverse direction", () => {
    useRepo.setState({
      summary: localSummary,
      branches: [localBranch("feature"), localBranch("main")],
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    // feature is the actor; main (the target) is never the one rebased/reset.
    expect(screen.getByRole("menuitem", { name: /Rebase feature onto main/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Reset feature to main/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Rebase main onto feature/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Reset main to feature/ })).not.toBeInTheDocument();
  });

  it("reset-source previews then resets the dragged branch to the drop target on confirm", async () => {
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    const resetCurrentTo = vi.fn().mockResolvedValue("Reset to main");
    useRepo.setState({
      summary: localSummary,
      branches: [localBranch("feature"), localBranch("main")],
      checkoutBranch,
      resetCurrentTo,
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: /Reset feature to main/ }));

    // Preview is anchored on the branch being reset (feature), not HEAD.
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
    expect(invokeMock).toHaveBeenCalledWith(
      "preview_reset",
      expect.objectContaining({ target: "main", mode: "mixed", source: "feature" }),
    );

    useUi.getState().confirm!.onConfirm();
    await waitFor(() => expect(resetCurrentTo).toHaveBeenCalledWith("main", "mixed"));
    expect(checkoutBranch).toHaveBeenCalledWith("feature");
  });

  it("moves the local target when a remote ref is dragged onto it (the remote can't move)", async () => {
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    const rebaseOnto = vi.fn().mockResolvedValue("Rebased onto origin/feature");
    useRepo.setState({
      summary: localSummary,
      branches: [remoteBranch("origin/feature"), localBranch("main")],
      checkoutBranch,
      rebaseOnto,
    });
    useUi.setState({
      actionMenu: {
        x: 10,
        y: 10,
        from: { name: "origin/feature", kind: "remote" },
        to: { kind: "local", name: "main" },
      },
    });
    render(<ActionMenu />);

    // Remote source only feeds the local target: it is never itself moved.
    expect(screen.queryByRole("menuitem", { name: /Rebase origin\/feature onto main/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Reset origin\/feature to main/ })).not.toBeInTheDocument();

    // The only rebase offered moves the local target onto the remote.
    fireEvent.click(screen.getByRole("menuitem", { name: /Rebase main onto origin\/feature/ }));
    await waitFor(() => expect(rebaseOnto).toHaveBeenCalledWith("origin/feature"));
    expect(checkoutBranch).toHaveBeenCalledWith("main");
  });
});

describe("WorktreeContextMenu", () => {
  it("offers open / copy-path / remove for a non-active linked worktree", () => {
    useUi.setState({ worktreeMenu: { x: 10, y: 10, path: "/work/repo-wt", name: "feature", isMain: false } });
    render(<WorktreeContextMenu />);
    // No redundant "Continue in" group: "Open worktree" is the single switch action.
    expect(screen.queryByText("Continue in")).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open worktree" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remove worktree" })).toBeInTheDocument();
  });

  it("opens the non-active main worktree via Open worktree", () => {
    const openWorktree = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      summary: {
        path: "/work/repo-wt",
        workdir: "/work/repo-wt",
        headBranch: "feature",
        headOid: null,
        detached: false,
      },
      openWorktree,
    });
    useUi.setState({ worktreeMenu: { x: 10, y: 10, path: "/work/repo", name: "main", isMain: true } });
    render(<WorktreeContextMenu />);
    expect(screen.queryByText("Continue in")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Local checkout" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remove worktree" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open worktree" }));
    expect(openWorktree).toHaveBeenCalledWith("/work/repo");
  });

  it("shows only Copy path for the active main worktree", () => {
    useRepo.setState({
      summary: {
        path: "/work/repo",
        workdir: "/work/repo",
        headBranch: "main",
        headOid: null,
        detached: false,
      },
    });
    useUi.setState({ worktreeMenu: { x: 10, y: 10, path: "/work/repo", name: "main", isMain: true } });
    render(<WorktreeContextMenu />);
    expect(screen.queryByRole("menuitem", { name: "Open worktree" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remove worktree" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
  });

  it("shows only Copy path for the linked worktree backing the open repo", () => {
    // App opened on a linked worktree: isMain is false, but it's the active
    // checkout, so neither "Open worktree" (no-op) nor "Remove worktree"
    // (deletes the active tab's directory) is offered.
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
    expect(screen.queryByRole("menuitem", { name: "Open worktree" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remove worktree" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
  });
});
