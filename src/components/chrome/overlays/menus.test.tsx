import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useNotifications } from "@/store/notifications";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { BranchRow } from "@/components/navigation/branch-navigator/rows";
import { ActionMenu, BranchContextMenu, TagContextMenu, WipContextMenu, WorktreeContextMenu } from "./menus";

// useBranchFastForwardProbe calls `api.canFastForward` (→ invoke) while a branch
// other than HEAD is selected, so the IPC boundary must be mocked. Reject
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
const realCheckoutRemoteBranch = useRepo.getState().checkoutRemoteBranch;
const realRebaseOnto = useRepo.getState().rebaseOnto;
const realResetBranchTo = useRepo.getState().resetBranchTo;
const realMergeInto = useRepo.getState().mergeInto;
const realForcePush = useRepo.getState().forcePush;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "can_fast_forward") return Promise.resolve(false);
    // GL-296: the removal confirm probes the worktree first; default to clean
    // so only the tests that care about dirtiness opt into it.
    if (cmd === "worktree_dirty_state") return Promise.resolve({ modified: 0, untracked: 0 });
    if (cmd === "preview_remove_worktree") {
      return Promise.resolve({
        summary: "Impact summary",
        details: ["Affected path"],
        warnings: ["Recovery warning"],
        requiresForce: false,
        locked: false,
        dirty: false,
        ignoredOnly: false,
        expectedState: "worktree-removal-lease-v1",
      });
    }
    if (cmd.startsWith("preview_")) {
      return Promise.resolve({
        summary: "Impact summary",
        details: ["Affected path"],
        warnings: ["Recovery warning"],
        expectedOid: "branch-preview-oid",
        expectedState: "discard-all-state-v1",
        expectedHeadBranch: "main",
        expectedHeadOid: "head",
        targetOid: "target-preview-oid",
        expectedSourceOid: "source-preview-oid",
      });
    }
    return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
  });
  useRepo.setState({
    changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
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
    checkoutRemoteBranch: realCheckoutRemoteBranch,
    rebaseOnto: realRebaseOnto,
    resetBranchTo: realResetBranchTo,
    mergeInto: realMergeInto,
    forcePush: realForcePush,
  });
  useUi.setState({
    wipMenu: null,
    tagMenu: null,
    worktreeMenu: null,
    contextMenu: null,
    actionMenu: null,
    confirm: null,
    prompt: null,
    deleteWorktree: null,
    createBranchOpen: false,
    createBranchStart: null,
  });
  useNotifications.setState({ toasts: [] });
});

const localBranch = (name: string) => ({
  name,
  kind: "local" as const,
  target: "abc1234",
  isHead: false,
  upstream: null,
  remote: null,
});

const remoteBranch = (name: string) => ({
  name,
  kind: "remote" as const,
  target: "abc1234",
  isHead: false,
  upstream: null,
  // Backend attributes each remote branch to its remote; the delete-on-remote
  // action reads this rather than splitting the name on the first `/`.
  remote: name.split("/")[0],
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
    useRepo.setState({ changes: { staged: [], unstaged: [file("a.ts")], conflicted: [], advanced: emptyAdvancedState } });
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
        advanced: emptyAdvancedState,
      },
    });
    useUi.setState({ wipMenu: { x: 10, y: 10 } });
    render(<WipContextMenu />);

    expect(screen.getByRole("menuitem", { name: "Stage all changes" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Stash all changes" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Discard all changes" })).toBeDisabled();
    expect(screen.getAllByText("Submodule: modified files inside submodule. Use the terminal for submodule updates.")).toHaveLength(3);
  });

  it("blocks only Discard all for an in-cone sparse change", () => {
    useRepo.setState({
      changes: {
        staged: [],
        unstaged: [file("src/a.ts")],
        conflicted: [],
        advanced: {
          submodules: [],
          lfs: { detected: false, installed: null, issues: [], patterns: [] },
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["src/"] },
        },
      },
    });
    useUi.setState({ wipMenu: { x: 10, y: 10 } });
    render(<WipContextMenu />);

    expect(screen.getByRole("menuitem", { name: "Stage all changes" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Stash all changes" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Discard all changes" })).toBeDisabled();
    expect(screen.getByText(
      "Sparse checkout is enabled. Disable sparse checkout before using Discard all, or use the terminal.",
    )).toBeInTheDocument();
  });

  it("shows Unstage all only when there are staged files", () => {
    useRepo.setState({ changes: { staged: [file("b.ts")], unstaged: [], conflicted: [], advanced: emptyAdvancedState } });
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
      expectedState: string;
      expectedHeadBranch: string | null;
      expectedHeadOid: string | null;
    }>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "preview_discard_all") return pending.promise;
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "head", detached: false },
      changes: { staged: [file("b.ts")], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
    });
    useUi.setState({ wipMenu: { x: 10, y: 10 } });
    render(<WipContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Discard all changes" }));

    await waitFor(() => expect(useUi.getState().wipMenu).toBeNull());
    expect(useUi.getState().confirm).toBeNull();

    pending.resolve({
      summary: "Impact summary",
      details: ["Affected path"],
      warnings: [],
      expectedState: "discard-all-state-v1",
      expectedHeadBranch: "main",
      expectedHeadOid: "head",
    });
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
  });
});

describe("TagContextMenu", () => {
  it("offers checkout / push / create / copy / delete for a tag", () => {
    useUi.setState({
      tagMenu: { x: 10, y: 10, name: "v1.0.0", sha: "abc1234", refOid: "tag-object-1" },
    });
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

  it("routes the everywhere-delete with the exact tag target after confirm", async () => {
    const deleteTag = vi.fn().mockResolvedValue("Deleted tag v1.0.0 (local and origin)");
    useRepo.setState({ deleteTag });
    useUi.setState({
      tagMenu: { x: 10, y: 10, name: "v1.0.0", sha: "abc1234", refOid: "tag-object-1" },
    });
    render(<TagContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete from local and origin" }));
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    confirm!.onConfirm();
    await waitFor(() =>
      expect(deleteTag).toHaveBeenCalledWith("v1.0.0", "tag-object-1", true),
    );
  });

  // A branch and a tag can share a short name, so the operations must reference
  // the peeled commit sha — never the ambiguous tag name.
  it("uses the tag sha (not its name) as the create-branch start point", () => {
    useUi.setState({
      tagMenu: {
        x: 10,
        y: 10,
        name: "v1.0.0",
        sha: "abc1234deadbeef",
        refOid: "tag-object-1",
      },
    });
    render(<TagContextMenu />);
    openGroup("Create");
    fireEvent.click(screen.getByRole("menuitem", { name: "Branch from here…" }));
    expect(useUi.getState().createBranchStart).toBe("abc1234deadbeef");
    expect(useUi.getState().createBranchOpen).toBe(true);
  });

  it("uses the tag sha (not its name) as the create-worktree reference", async () => {
    const createWorktreeAt = vi.fn().mockResolvedValue("created");
    useRepo.setState({ createWorktreeAt });
    useUi.setState({
      tagMenu: {
        x: 10,
        y: 10,
        name: "v1.0.0",
        sha: "abc1234deadbeef",
        refOid: "tag-object-1",
      },
    });
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
  it("opens the tag menu carrying the peeled commit and exact ref target", () => {
    render(
      <BranchRow name="v2.3.4" kind="tag" oid="deadbeefcafe" refOid="tag-object-2" />,
    );
    fireEvent.contextMenu(screen.getByText("v2.3.4"));
    const menu = useUi.getState().tagMenu;
    expect(menu?.name).toBe("v2.3.4");
    expect(menu?.sha).toBe("deadbeefcafe");
    expect(menu?.refOid).toBe("tag-object-2");
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

  // Most-used first: Create leads, Compare (read-only) trails next to Copy.
  it("orders the intent groups Create → Integrate → Worktree → Compare", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);

    const rows = ["Create", "Integrate into current", "Worktree", "Compare"].map((name) =>
      screen.getByRole("menuitem", { name }),
    );
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i].compareDocumentPosition(rows[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  // The Worktree group is the single home for worktree actions: with no
  // worktree it offers creation (which used to hide inside Create).
  it("offers New worktree here… under Worktree (not Create) when the branch has no worktree", async () => {
    const createWorktreeAt = vi.fn().mockResolvedValue("created");
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
      createWorktreeAt,
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);

    openGroup("Create");
    expect(screen.getByRole("menuitem", { name: "Branch from here…" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Worktree from branch…" })).not.toBeInTheDocument();

    openGroup("Worktree");
    fireEvent.click(screen.getByRole("menuitem", { name: "New worktree here…" }));
    const prompt = useUi.getState().prompt;
    expect(prompt?.title).toContain("feature");
    prompt!.onSubmit("/work/repo-wt-feature");
    await waitFor(() =>
      expect(createWorktreeAt).toHaveBeenCalledWith("/work/repo-wt-feature", "feature"),
    );
  });

  // wtRef regression guard: git refuses a second checkout of the same branch,
  // so with the branch held in a linked worktree, "New worktree here…" must
  // create DETACHED at the tip sha — and the prompt must say so.
  it("creates a detached worktree at the tip when the branch is checked out elsewhere", async () => {
    const createWorktreeAt = vi.fn().mockResolvedValue("created");
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
      worktrees: [
        { name: "repo", path: "/work/repo", branch: "main", isMain: true },
        { name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false },
      ],
      createWorktreeAt,
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);

    openGroup("Worktree");
    fireEvent.click(screen.getByRole("menuitem", { name: "New worktree here…" }));
    const prompt = useUi.getState().prompt;
    expect(prompt?.message).toContain("without a branch");
    expect(prompt?.message).not.toContain("linked");
    expect(prompt?.message).toContain("abc1234");
    prompt!.onSubmit("/work/repo-wt-2");
    await waitFor(() =>
      expect(createWorktreeAt).toHaveBeenCalledWith("/work/repo-wt-2", "abc1234"),
    );
  });

  it("offers fast-forward when the probe confirms it", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "can_fast_forward" ? Promise.resolve(true) : Promise.reject(new Error(`unexpected invoke: ${cmd}`)),
    );
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "1111111", detached: false },
      branches: [
        { ...localBranch("main"), target: "1111111", isHead: true },
        { ...localBranch("feature"), target: "2222222" },
      ],
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("can_fast_forward", {
        path: "/work/repo",
        from: "2222222",
        to: "1111111",
      }),
    );
    openGroup("Integrate into current");
    expect(screen.getByRole("menuitem", { name: "Fast-forward to feature" })).toBeInTheDocument();
  });

  it("stops probing and hides integration when live HEAD moves onto the open menu branch", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "can_fast_forward" ? Promise.resolve(true) : Promise.reject(new Error(`unexpected invoke: ${cmd}`)),
    );
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "branch-b", headOid: "bbbbbbb", detached: false },
      branches: [
        { ...localBranch("branch-a"), target: "aaaaaaa" },
        { ...localBranch("branch-b"), target: "bbbbbbb", isHead: true },
      ],
    });
    const opening = { x: 10, y: 10, branch: "branch-a", isCurrent: false };
    useUi.setState({ contextMenu: opening });
    render(<BranchContextMenu />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("can_fast_forward", {
      path: "/work/repo",
      from: "aaaaaaa",
      to: "bbbbbbb",
    }));
    openGroup("Integrate into current");
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Fast-forward to branch-a" })).toBeInTheDocument(),
    );

    act(() => {
      useRepo.setState({
        summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "branch-a", headOid: "aaaaaaa", detached: false },
        branches: [
          { ...localBranch("branch-a"), target: "aaaaaaa", isHead: true },
          { ...localBranch("branch-b"), target: "bbbbbbb" },
        ],
      });
    });

    expect(useUi.getState().contextMenu).toBe(opening);
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "Fast-forward to branch-a" })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("menuitem", { name: "Integrate into current" })).not.toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalledWith("can_fast_forward", {
      path: "/work/repo",
      from: "aaaaaaa",
      to: "aaaaaaa",
    });
  });

  it("hides tip-derived actions when local and remote refs share a display name", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "1111111", detached: false },
      branches: [
        { ...localBranch("main"), target: "1111111", isHead: true },
        { ...localBranch("origin/feature"), target: "2222222" },
        { ...remoteBranch("origin/feature"), target: "3333333" },
      ],
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "origin/feature", isCurrent: false } });
    render(<BranchContextMenu />);

    // With the ref unresolvable, every action that would act on the wrong
    // match's tip or kind must vanish — not act on whichever came first.
    openGroup("Integrate into current");
    expect(screen.queryByRole("menuitem", { name: "Cherry-pick tip" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Merge origin/feature" })).toBeInTheDocument();
    // Reset-to-tip and the local/remote delete items are all tip/kind-derived,
    // so the whole Danger zone group disappears with them.
    expect(screen.queryByRole("menuitem", { name: "Danger zone" })).not.toBeInTheDocument();
  });

  it("fails closed on the FF probe when local and remote refs share a display name", () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "can_fast_forward" ? Promise.resolve(true) : Promise.reject(new Error(`unexpected invoke: ${cmd}`)),
    );
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "1111111", detached: false },
      branches: [
        { ...localBranch("main"), target: "1111111", isHead: true },
        // A local branch literally named like the remote ref, plus the remote
        // ref itself — the menu payload has no kind, so the oid is ambiguous.
        { ...localBranch("origin/feature"), target: "2222222" },
        { ...remoteBranch("origin/feature"), target: "3333333" },
      ],
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "origin/feature", isCurrent: false } });
    render(<BranchContextMenu />);

    expect(invokeMock).not.toHaveBeenCalledWith("can_fast_forward", expect.anything());
    openGroup("Integrate into current");
    expect(
      screen.queryByRole("menuitem", { name: "Fast-forward to origin/feature" }),
    ).not.toBeInTheDocument();
  });

  it("confirms and preserves the current/target pair for a branch-menu rebase", async () => {
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    const rebaseOnto = vi.fn().mockResolvedValue("Rebased main onto feature");
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "head", detached: false },
      branches: [localBranch("main"), localBranch("feature")],
      checkoutBranch,
      rebaseOnto,
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);

    openGroup("Integrate into current");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rebase onto feature" }));

    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    expect(confirm!.title).toBe("Rebase main onto feature?");
    expect(rebaseOnto).not.toHaveBeenCalled();
    confirm!.onConfirm();

    await waitFor(() => expect(rebaseOnto).toHaveBeenCalledWith("main", "feature"));
    expect(checkoutBranch).not.toHaveBeenCalled();
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

  it("confirms force-push with the exact route and lease returned by its preview", async () => {
    const preview = {
      summary: "Force-push main with lease",
      details: ["Pushes main to fork at refs/heads/main."],
      warnings: ["The destination must still match the preview."],
      expectedOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      remote: "fork",
      destinationRef: "refs/heads/main",
      destinationOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      pushEndpointToken: "endpoint-token",
    };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "preview_force_push") return Promise.resolve(preview);
      if (cmd === "can_fast_forward") return Promise.resolve(false);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    const forcePush = vi.fn().mockResolvedValue("Force-pushed main (with lease)");
    useRepo.setState({
      summary: {
        path: "/work/repo",
        workdir: "/work/repo",
        headBranch: "main",
        headOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        detached: false,
      },
      branches: [{ ...localBranch("main"), isHead: true }],
      forcePush,
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "main", isCurrent: true } });

    render(<BranchContextMenu />);
    openGroup("Danger zone");
    fireEvent.click(screen.getByRole("menuitem", { name: "Force push (with lease)…" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("preview_force_push", {
      path: "/work/repo",
      branch: "main",
    }));
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
    useUi.getState().confirm!.onConfirm();

    await waitFor(() => expect(forcePush).toHaveBeenCalledWith("main", preview));
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
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
      worktrees: [
        { name: "repo", path: "/work/repo", branch: "main", isMain: true },
        { name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false },
      ],
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);
    // Open worktree is promoted to the top.
    expect(screen.getByRole("menuitem", { name: "Open worktree" })).toBeInTheDocument();
    // Checkout stays hidden: offering it would only produce a git worktree error.
    expect(screen.queryByRole("menuitem", { name: "Checkout feature" })).not.toBeInTheDocument();
    // Worktree group is the one home for everything worktree: open (also kept
    // promoted on top, under a distinct label so AT can tell the two apart),
    // copy path, create another, hand off, remove.
    openGroup("Worktree");
    expect(screen.getByRole("menuitem", { name: "Open this worktree" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy worktree path" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "New worktree here…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remove worktree" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Hand off to…" }));
    // The dedicated hand-off dialog opens on the branch's source worktree; its
    // dirtiness is unknown from here (it isn't the open repo).
    expect(useUi.getState().handoff).toEqual({
      branch: "feature",
      sourcePath: "/work/repo-feature",
      sourceChanges: null,
    });
  });

  // Checkout is impossible while another worktree holds the branch, but the
  // menu still offers a way to reclaim it: "Check out here…" opens the hand-off
  // dialog preset to the open worktree (detach there → check out here), so the
  // user never has to switch into the holding worktree — typically a stale
  // agent scratch checkout — just to get their branch back.
  it("offers Check out here… that opens the hand-off preset to the open worktree", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
      worktrees: [
        { name: "repo", path: "/work/repo", branch: "main", isMain: true },
        { name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false },
      ],
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Check out here…" }));
    expect(useUi.getState().handoff).toEqual({
      branch: "feature",
      sourcePath: "/work/repo-feature",
      sourceChanges: null,
      destPath: "/work/repo",
    });
  });

  // A prunable holder (its directory is gone) can't run the hand-off's detach
  // step, so no hand-off entry point may be offered from it — neither the
  // promoted reclaim action nor the Worktree group's generic hand-off.
  it("hides Check out here… and Hand off to… when the holding worktree is prunable", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
      worktrees: [
        { name: "repo", path: "/work/repo", branch: "main", isMain: true },
        { name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false, prunable: true },
      ],
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);
    expect(screen.queryByRole("menuitem", { name: "Check out here…" })).not.toBeInTheDocument();
    openGroup("Worktree");
    expect(screen.queryByRole("menuitem", { name: "Hand off to…" })).not.toBeInTheDocument();
  });

  it("hides the worktree menu's hand-off for a prunable worktree", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      worktrees: [
        { name: "repo", path: "/work/repo", branch: "main", isMain: true },
        { name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false, prunable: true },
      ],
    });
    useUi.setState({ worktreeMenu: { x: 10, y: 10, path: "/work/repo-feature", name: "repo-feature", isMain: false } });
    render(<WorktreeContextMenu />);
    expect(screen.queryByRole("menuitem", { name: "Hand off branch to…" })).not.toBeInTheDocument();
  });

  // "Hand off to…" is hidden when no *valid* destination exists — the only other
  // worktree here is the bare main repo, which can't receive a checkout. The
  // promoted "Check out here…" follows the same rule: a bare open repo can't
  // receive the branch either.
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
    expect(screen.queryByRole("menuitem", { name: "Check out here…" })).not.toBeInTheDocument();
    openGroup("Worktree");
    expect(screen.queryByRole("menuitem", { name: "Hand off to…" })).not.toBeInTheDocument();
  });

  // The combined action opens the delete-branch-and-worktree modal (GL-107),
  // which owns the impact preview + live progress checklist. The menu just hands
  // it the subject; it no longer previews or runs the delete inline.
  it("opens the delete-branch-and-worktree modal with the branch and worktree path", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "head", detached: false },
      branches: [localBranch("feature")],
      worktrees: [{ name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false }],
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "feature", isCurrent: false } });
    render(<BranchContextMenu />);

    openGroup("Danger zone");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete feature & worktree…" }));
    // The modal request is set (the menu closes); no inline confirm/preview fires.
    expect(useUi.getState().deleteWorktree).toEqual({
      branch: "feature",
      worktreePath: "/work/repo-feature",
    });
    expect(useUi.getState().confirm).toBeNull();
  });

  // "Remove worktree" (in the Worktree group) keeps the branch — it only removes
  // the worktree dir (the keep-the-branch counterpart to the combined delete).
  it("removes only the worktree (keeping the branch) on confirm", async () => {
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
    // The confirm is raised only after the GL-296 dirty probe resolves.
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
    const confirm = useUi.getState().confirm;
    confirm!.onConfirm();
    // Clean, unlocked worktree → leased removal (server derives force).
    expect(removeWorktree).toHaveBeenCalledWith(
      "/work/repo-feature",
      "worktree-removal-lease-v1",
    );
    // The branch is untouched — the combined delete must not fire.
    expect(deleteBranchWithWorktree).not.toHaveBeenCalled();
  });

  // A locked worktree needs a forced removal (`--force --force` on the backend);
  // the confirm surfaces the lock; execute still sends only the lease token.
  it("forces removal of a locked worktree and warns in the confirm", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "can_fast_forward") return Promise.resolve(false);
      if (cmd === "preview_remove_worktree") {
        return Promise.resolve({
          summary: "Impact summary",
          details: ["Affected path"],
          warnings: ["This worktree is locked."],
          requiresForce: true,
          locked: true,
          dirty: false,
          ignoredOnly: false,
          expectedState: "worktree-removal-lease-locked-v1",
        });
      }
      if (cmd.startsWith("preview_")) {
        return Promise.resolve({
          summary: "Impact summary",
          details: ["Affected path"],
          warnings: ["Recovery warning"],
          expectedOid: "branch-preview-oid",
          expectedState: "discard-all-state-v1",
          expectedHeadBranch: "main",
          expectedHeadOid: "head",
        });
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
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
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
    const confirm = useUi.getState().confirm;
    expect(confirm?.warnings?.join(" ")).toMatch(/locked/i);
    confirm!.onConfirm();
    expect(removeWorktree).toHaveBeenCalledWith(
      "/work/repo-feature",
      "worktree-removal-lease-locked-v1",
    );
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
    // Opening the main worktree is still fine (top quick action + in the group).
    expect(screen.getByRole("menuitem", { name: "Open worktree" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open this worktree" })).toBeInTheDocument();
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

  it("checks out a remote-only branch as a local tracking branch", async () => {
    const checkoutRemoteBranch = vi.fn().mockResolvedValue("Checked out feature");
    const checkoutBranch = vi.fn().mockResolvedValue("detached");
    useRepo.setState({
      branches: [remoteBranch("origin/feature")],
      checkoutRemoteBranch,
      checkoutBranch,
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "origin/feature", isCurrent: false } });
    render(<BranchContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Checkout feature" }));

    await waitFor(() => expect(checkoutRemoteBranch).toHaveBeenCalledWith("origin", "feature"));
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("checks out and updates the local branch when it already exists", async () => {
    const checkoutRemoteBranch = vi.fn().mockResolvedValue("Checked out feature");
    const checkoutBranch = vi.fn().mockResolvedValue("detached");
    useRepo.setState({
      branches: [localBranch("feature"), remoteBranch("origin/feature")],
      checkoutRemoteBranch,
      checkoutBranch,
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "origin/feature", isCurrent: false } });
    render(<BranchContextMenu />);

    expect(screen.getByRole("menuitem", { name: "Checkout origin/feature detached" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Checkout feature" }));

    await waitFor(() => expect(checkoutRemoteBranch).toHaveBeenCalledWith("origin", "feature"));
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("keeps detached inspection available for an existing local branch", async () => {
    const checkoutRemoteBranch = vi.fn().mockResolvedValue("Checked out feature");
    const checkoutBranch = vi.fn().mockResolvedValue("detached");
    useRepo.setState({
      branches: [localBranch("feature"), remoteBranch("origin/feature")],
      checkoutRemoteBranch,
      checkoutBranch,
    });
    useUi.setState({ contextMenu: { x: 10, y: 10, branch: "origin/feature", isCurrent: false } });
    render(<BranchContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Checkout origin/feature detached" }));

    await waitFor(() => expect(checkoutBranch).toHaveBeenCalledWith("origin/feature"));
    expect(checkoutRemoteBranch).not.toHaveBeenCalled();
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
    await waitFor(() =>
      expect(removeBranch).toHaveBeenCalledWith(
        "feature",
        "branch-preview-oid",
        "/work/repo",
        true,
      ),
    );
  });

  it("does not run a captured branch-delete confirmation after switching repos", async () => {
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
    const confirm = useUi.getState().confirm!;

    useRepo.setState({
      summary: { path: "/work/other", workdir: "/work/other", headBranch: "main", headOid: "other", detached: false },
    });
    confirm.onConfirm();

    expect(removeBranch).not.toHaveBeenCalled();
    expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toMatch(/Repository changed/i);
  });

  it("does not open a reset confirmation if HEAD changes while the preview is pending", async () => {
    const pending = deferred<{
      summary: string;
      details: string[];
      warnings: string[];
      targetOid: string;
      expectedSourceOid: string;
      expectedState: string | null;
      expectedHeadBranch: string;
      expectedHeadOid: string;
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
    pending.resolve({
      summary: "Impact summary",
      details: ["Affected path"],
      warnings: [],
      targetOid: "target-preview-oid",
      expectedSourceOid: "source-preview-oid",
      expectedState: null,
      expectedHeadBranch: "main",
      expectedHeadOid: "old",
    });

    await waitFor(() =>
      expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toContain("HEAD changed"),
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

  // Rebases always confirm the immutable source/target pair. The backend owns
  // the source checkout in the same git process, so a previously active branch
  // cannot become the accidental rebase actor between two IPC calls.
  it("rebase-source confirms the exact pair and sends both operands atomically", async () => {
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

    // Nothing ran yet — the confirm names the branch, prerequisite, and target.
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    expect(confirm!.title).toBe("Rebase feature onto main?");
    expect(confirm!.message).toContain('Check out branch "feature"');
    expect(confirm!.message).toContain('onto "main"');
    expect(confirm!.confirmLabel).toBe("Check out feature and rebase");
    expect(checkoutBranch).not.toHaveBeenCalled();
    expect(rebaseOnto).not.toHaveBeenCalled();

    confirm!.onConfirm();
    await waitFor(() => expect(rebaseOnto).toHaveBeenCalledWith("feature", "main"));
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("cancelling the rebase confirmation performs neither checkout nor rebase", () => {
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

    fireEvent.click(screen.getByRole("menuitem", { name: /Rebase feature onto main/ }));
    expect(useUi.getState().confirm).not.toBeNull();

    // The dialog cancels by clearing the pending confirm without running it.
    useUi.getState().closeConfirm();
    expect(useUi.getState().confirm).toBeNull();
    expect(checkoutBranch).not.toHaveBeenCalled();
    expect(rebaseOnto).not.toHaveBeenCalled();
  });

  it("still confirms the exact pair when the rebased branch is already checked out", async () => {
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    const rebaseOnto = vi.fn().mockResolvedValue("Rebased onto main");
    useRepo.setState({
      // feature is HEAD → no branch switch is needed, but rebase still confirms.
      summary: { ...localSummary, headBranch: "feature" },
      branches: [localBranch("feature"), localBranch("main")],
      checkoutBranch,
      rebaseOnto,
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: /Rebase feature onto main/ }));
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    expect(confirm!.title).toBe("Rebase feature onto main?");
    expect(confirm!.confirmLabel).toBe("Rebase");
    confirm!.onConfirm();
    await waitFor(() => expect(rebaseOnto).toHaveBeenCalledWith("feature", "main"));
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("merge-target asks to approve the implicit checkout of the drop target", async () => {
    const mergeInto = vi.fn().mockResolvedValue("Merged feature into main");
    useRepo.setState({
      // HEAD is elsewhere, so merging into main first checks main out.
      summary: { ...localSummary, headBranch: "feature" },
      branches: [localBranch("feature"), localBranch("main")],
      mergeInto,
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: /Merge feature into main/ }));
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    expect(confirm!.title).toBe("Check out main?");
    expect(confirm!.confirmLabel).toBe("Check out and merge");
    expect(mergeInto).not.toHaveBeenCalled();

    confirm!.onConfirm();
    await waitFor(() => expect(mergeInto).toHaveBeenCalledWith("feature", "main"));
  });

  it("merges without a popup when the drop target is already checked out", async () => {
    const mergeInto = vi.fn().mockResolvedValue("Merged feature into main");
    useRepo.setState({
      summary: localSummary, // headBranch: "main" — the merge target
      branches: [localBranch("feature"), localBranch("main")],
      mergeInto,
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: /Merge feature into main/ }));
    expect(useUi.getState().confirm).toBeNull();
    await waitFor(() => expect(mergeInto).toHaveBeenCalledWith("feature", "main"));
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

  it("never offers the target-moving fast-forward on a local drag, even when it's possible", async () => {
    // The target (main) *could* fast-forward to the dragged branch (feature),
    // but on a local drag only the dragged branch moves — so the reverse FF must
    // not appear, and the wasted probe for it isn't even issued.
    invokeMock.mockImplementation((cmd: string, args: { from: string; to: string }) => {
      if (cmd === "can_fast_forward") {
        // Reverse direction (advance main to feature) would be offered if read.
        if (args.from === "feature" && args.to === "main") return Promise.resolve(true);
        return Promise.resolve(false);
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    useRepo.setState({
      summary: localSummary,
      branches: [localBranch("feature"), localBranch("main")],
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: /Rebase feature onto main/ })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("menuitem", { name: /Fast-forward main to feature/ })).not.toBeInTheDocument();
    // The reverse-direction probe (from=feature,to=main) is never issued.
    expect(invokeMock).not.toHaveBeenCalledWith(
      "can_fast_forward",
      expect.objectContaining({ from: "feature", to: "main" }),
    );
  });

  it("reset-source previews then resets the dragged branch to the drop target on confirm", async () => {
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    const resetBranchTo = vi.fn().mockResolvedValue("Reset feature to main");
    useRepo.setState({
      summary: localSummary,
      branches: [localBranch("feature"), localBranch("main")],
      checkoutBranch,
      resetBranchTo,
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
    // HEAD is main, so the single dialog also covers the checkout prerequisite
    // (GL-217) — no second popup stacks on top of the preview confirm.
    expect(useUi.getState().confirm!.message).toContain('Check out branch "feature"');
    expect(useUi.getState().confirm!.confirmLabel).toBe("Check out feature and reset (mixed)");

    useUi.getState().confirm!.onConfirm();
    await waitFor(() =>
      expect(resetBranchTo).toHaveBeenCalledWith(
        "feature",
        "main",
        "mixed",
        expect.objectContaining({ targetOid: "target-preview-oid" }),
      ),
    );
    expect(checkoutBranch).not.toHaveBeenCalled();
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
    // HEAD is already main, so the confirmation needs no checkout warning.
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    expect(confirm!.title).toBe("Rebase main onto origin/feature?");
    expect(confirm!.confirmLabel).toBe("Rebase");
    confirm!.onConfirm();
    await waitFor(() => expect(rebaseOnto).toHaveBeenCalledWith("main", "origin/feature"));
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("rebase-target asks to approve the checkout when HEAD is on a different branch", async () => {
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    const rebaseOnto = vi.fn().mockResolvedValue("Rebased onto origin/feature");
    useRepo.setState({
      // HEAD is elsewhere: rebasing the drop target (main) first checks it out.
      summary: { ...localSummary, headBranch: "feature" },
      branches: [remoteBranch("origin/feature"), localBranch("main"), localBranch("feature")],
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

    fireEvent.click(screen.getByRole("menuitem", { name: /Rebase main onto origin\/feature/ }));
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();
    expect(confirm!.title).toBe("Rebase main onto origin/feature?");
    expect(confirm!.confirmLabel).toBe("Check out main and rebase");
    expect(checkoutBranch).not.toHaveBeenCalled();

    confirm!.onConfirm();
    await waitFor(() => expect(rebaseOnto).toHaveBeenCalledWith("main", "origin/feature"));
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("always asks before a checkout-based op when HEAD is detached", () => {
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      // Detached HEAD: any branch checkout is a real switch, so the gate shows
      // even though headBranch may still report the last branch name.
      summary: { ...localSummary, headBranch: "feature", detached: true },
      branches: [localBranch("feature"), localBranch("main")],
      checkoutBranch,
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: /Rebase feature onto main/ }));
    expect(useUi.getState().confirm).not.toBeNull();
    expect(useUi.getState().confirm!.title).toBe("Rebase feature onto main?");
    expect(useUi.getState().confirm!.confirmLabel).toBe("Check out feature and rebase");
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  // A checkout-based op (rebase/reset of the dragged branch, or merge — all check
  // out the branch they mutate) can't run when git already has that branch out in
  // another worktree. GL-103: disable it up front instead of letting the checkout
  // fail with a raw worktree error.
  it("disables the dragged-branch ops when the dragged branch lives in another worktree", () => {
    const checkoutBranch = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      summary: localSummary,
      branches: [localBranch("feature"), localBranch("main")],
      worktrees: [{ name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false }],
      checkoutBranch,
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    const rebase = screen.getByRole("menuitem", { name: /Rebase feature onto main/ });
    const reset = screen.getByRole("menuitem", { name: /Reset feature to main/ });
    expect(rebase).toBeDisabled();
    expect(reset).toBeDisabled();
    expect(rebase).toHaveTextContent("feature is checked out in worktree repo-feature");

    // Clicking the disabled op does nothing — no checkout is attempted.
    fireEvent.click(rebase);
    expect(checkoutBranch).not.toHaveBeenCalled();

    // Merge checks out the *target* (main), which is free, so it stays enabled.
    expect(screen.getByRole("menuitem", { name: /Merge feature into main/ })).toBeEnabled();
  });

  it("disables Merge when the drop-target branch lives in another worktree", () => {
    useRepo.setState({
      summary: localSummary,
      branches: [localBranch("feature"), localBranch("main")],
      worktrees: [{ name: "repo-main", path: "/work/repo-main", branch: "main", isMain: false }],
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    const merge = screen.getByRole("menuitem", { name: /Merge feature into main/ });
    expect(merge).toBeDisabled();
    expect(merge).toHaveTextContent("main is checked out in worktree repo-main");

    // Rebasing/resetting the dragged branch checks out feature (free) — enabled.
    expect(screen.getByRole("menuitem", { name: /Rebase feature onto main/ })).toBeEnabled();
  });

  it("keeps fast-forward enabled when the dragged branch lives in another worktree", async () => {
    // Fast-forward updates the branch in its owning worktree, so it stays
    // clickable when the branch is held elsewhere — unlike rebase/reset.
    invokeMock.mockImplementation((cmd: string, args: { from: string; to: string }) => {
      if (cmd === "can_fast_forward") {
        // Advancing feature to main (sourceToTarget) is possible → FF is offered.
        return Promise.resolve(args.from === "2222222" && args.to === "1111111");
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    useRepo.setState({
      summary: localSummary,
      branches: [
        { ...localBranch("feature"), target: "1111111" },
        { ...localBranch("main"), target: "2222222" },
      ],
      worktrees: [{ name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false }],
    });
    openActionMenu("feature", "main");
    render(<ActionMenu />);

    const ff = await screen.findByRole("menuitem", { name: /Fast-forward feature to main/ });
    expect(ff).toBeEnabled();
    // The checkout-based ops for the same held branch are still disabled.
    expect(screen.getByRole("menuitem", { name: /Rebase feature onto main/ })).toBeDisabled();
  });

  it("guards rebase/reset of the dragged branch when dropped on a commit", () => {
    useRepo.setState({
      summary: localSummary,
      branches: [localBranch("feature")],
      worktrees: [{ name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false }],
    });
    useUi.setState({
      actionMenu: {
        x: 10,
        y: 10,
        from: { name: "feature", kind: "local" },
        to: { kind: "commit", sha: "deadbeefcafe", shortSha: "deadbee" },
      },
    });
    render(<ActionMenu />);

    // Dropping the held branch on a commit still checks it out to rebase/reset.
    expect(screen.getByRole("menuitem", { name: /Rebase feature onto deadbee/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /Reset feature to deadbee/ })).toBeDisabled();
  });

  it("disables the target-moving ops when a remote source is dropped on a target held elsewhere", () => {
    useRepo.setState({
      summary: localSummary,
      branches: [remoteBranch("origin/feature"), localBranch("main")],
      worktrees: [{ name: "repo-main", path: "/work/repo-main", branch: "main", isMain: false }],
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

    // Both the merge and the rebase/reset of the target check out main → disabled.
    expect(screen.getByRole("menuitem", { name: /Merge origin\/feature into main/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /Rebase main onto origin\/feature/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /Reset main to origin\/feature/ })).toBeDisabled();
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
