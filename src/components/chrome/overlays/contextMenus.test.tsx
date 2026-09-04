import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRepo } from "@/store/repo";
import { AiActionScopeKind } from "@/features/agents/ai-actions";
import { useUi, tagMenuOf, wipMenuOf, MenuKind } from "@/store/ui";
import { useNotifications } from "@/store/notifications";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { isMac } from "@/lib/platform";
import { ShortcutId, shortcutParts } from "@/lib/shortcuts";
import { BranchRow } from "@/components/navigation/branch-navigator/rows";
import { MenuPanel } from "@/components/chrome/overlays/shared";
import { TagContextMenu, WipContextMenu, WorktreeContextMenu } from "./menus";

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
const realRevertCommit = useRepo.getState().revertCommit;

function expectShortcut(name: string, id: ShortcutId) {
  const item = screen.getByRole("menuitem", { name });
  const parts = shortcutParts(id, isMac);
  expect(item.querySelectorAll("kbd")).toHaveLength(parts.length);
  for (const part of parts) {
    expect(within(item).getByText(part)).toBeInTheDocument();
  }
}

function expectNoShortcut(name: string) {
  expect(screen.getByRole("menuitem", { name }).querySelector("kbd")).toBeNull();
}

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
    selectedCommits: [],
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
    revertCommit: realRevertCommit,
  });
  useUi.setState({
    menu: null,
    confirm: null,
    prompt: null,
    deleteWorktree: null,
    createBranchOpen: false,
    createBranchStart: null,
    aiActions: null,
  });
  useNotifications.setState({ toasts: [] });
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
    useUi.setState({ menu: { kind: MenuKind.Wip, state: { x: 10, y: 10 } } });
    render(<WipContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Commit…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Stash all changes" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Discard all changes" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Stage all changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Unstage all changes" })).not.toBeInTheDocument();
  });

  it("opens AI actions for the working tree", () => {
    useUi.setState({ menu: { kind: MenuKind.Wip, state: { x: 10, y: 10 } } });
    render(<WipContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "AI actions…" }));
    expect(useUi.getState().aiActions).toEqual({
      kind: AiActionScopeKind.Working,
    });
    expect(useUi.getState().menu).toBeNull();
  });

  it("ignores a commit selection the WIP row is not part of", () => {
    // Right-clicking WIP does not select it, so an earlier commit selection is
    // still in the store — it must not silently widen the scope.
    useRepo.setState({ selectedCommits: ["c0ffee1"], wipSelected: false });
    useUi.setState({ menu: { kind: MenuKind.Wip, state: { x: 10, y: 10 } } });
    render(<WipContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "AI actions…" }));
    expect(useUi.getState().aiActions).toEqual({
      kind: AiActionScopeKind.Working,
    });
  });

  it("shows platform shortcut badges on AI actions and Stash", () => {
    useUi.setState({ menu: { kind: MenuKind.Wip, state: { x: 10, y: 10 } } });
    render(<WipContextMenu />);
    expectShortcut("AI actions…", ShortcutId.AiActions);
    expectShortcut("Stash all changes", ShortcutId.Stash);
    expectNoShortcut("Commit…");
  });

  it("shows Stage all only when there are unstaged files", () => {
    useRepo.setState({ changes: { staged: [], unstaged: [file("a.ts")], conflicted: [], advanced: emptyAdvancedState } });
    useUi.setState({ menu: { kind: MenuKind.Wip, state: { x: 10, y: 10 } } });
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
    useUi.setState({ menu: { kind: MenuKind.Wip, state: { x: 10, y: 10 } } });
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
          sparseCheckout: { enabled: true, mode: "cone", patterns: ["src/"], truncated: false },
        },
      },
    });
    useUi.setState({ menu: { kind: MenuKind.Wip, state: { x: 10, y: 10 } } });
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
    useUi.setState({ menu: { kind: MenuKind.Wip, state: { x: 10, y: 10 } } });
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
    useUi.setState({ menu: { kind: MenuKind.Wip, state: { x: 10, y: 10 } } });
    render(<WipContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Discard all changes" }));

    await waitFor(() => expect(wipMenuOf(useUi.getState())).toBeNull());
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
  it("offers checkout / push / create / copy for a tag, with delete tucked under Danger zone", () => {
    useUi.setState({
      menu: { kind: MenuKind.Tag, state: { x: 10, y: 10, name: "v1.0.0", sha: "abc1234", refOid: "tag-object-1" } },
    });
    render(<TagContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Checkout tag (detached)" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Push tag to origin" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy tag name" })).toBeInTheDocument();
    // The two delete strengths live inside Danger zone, matching the branch menu.
    expect(screen.queryByRole("menuitem", { name: "Delete local tag" })).not.toBeInTheDocument();
    openGroup("Danger zone");
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
      menu: { kind: MenuKind.Tag, state: { x: 10, y: 10, name: "v1.0.0", sha: "abc1234", refOid: "tag-object-1" } },
    });
    render(<TagContextMenu />);
    openGroup("Danger zone");
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
      menu: { kind: MenuKind.Tag, state: {
        x: 10,
        y: 10,
        name: "v1.0.0",
        sha: "abc1234deadbeef",
        refOid: "tag-object-1",
      } },
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
      menu: { kind: MenuKind.Tag, state: {
        x: 10,
        y: 10,
        name: "v1.0.0",
        sha: "abc1234deadbeef",
        refOid: "tag-object-1",
      } },
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
    const menu = tagMenuOf(useUi.getState());
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

describe("WorktreeContextMenu", () => {
  it("offers open / copy-path / remove for a non-active linked worktree", () => {
    useUi.setState({ menu: { kind: MenuKind.Worktree, state: { x: 10, y: 10, path: "/work/repo-wt", name: "feature", isMain: false } } });
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
    useUi.setState({ menu: { kind: MenuKind.Worktree, state: { x: 10, y: 10, path: "/work/repo", name: "main", isMain: true } } });
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
    useUi.setState({ menu: { kind: MenuKind.Worktree, state: { x: 10, y: 10, path: "/work/repo", name: "main", isMain: true } } });
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
    useUi.setState({ menu: { kind: MenuKind.Worktree, state: { x: 10, y: 10, path: "/work/repo-wt/", name: "feature", isMain: false } } });
    render(<WorktreeContextMenu />);
    expect(screen.queryByRole("menuitem", { name: "Open worktree" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remove worktree" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
  });
});

// ADR 0004's skeleton, enforced by the panel rather than by each menu (GL-359).
// Separators used to be a per-row `sep` flag computed two different ways — one
// menu rewrote the first element of an array to carry it — so a conditionally
// empty section could leave a divider with nothing above or below it.

describe("MenuPanel groups (ADR 0004 skeleton)", () => {
  const dividers = (container: HTMLElement) =>
    container.querySelectorAll("div.h-px").length;

  it("draws one divider between consecutive non-empty groups and none around empty ones", () => {
    const { container, rerender } = render(
      <MenuPanel
        left={0}
        top={0}
        onClose={() => {}}
        groups={[[{ label: "One", onClick: () => {} }], [{ label: "Two", onClick: () => {} }]]}
      />,
    );
    expect(dividers(container)).toBe(1);

    // The middle group vanishing must not leave a stray divider, and must not
    // merge the survivors into one block either.
    rerender(
      <MenuPanel
        left={0}
        top={0}
        onClose={() => {}}
        groups={[[{ label: "One", onClick: () => {} }], [], [{ label: "Two", onClick: () => {} }]]}
      />,
    );
    expect(dividers(container)).toBe(1);

    // A single group needs no divider at all.
    rerender(
      <MenuPanel left={0} top={0} onClose={() => {}} groups={[[{ label: "One", onClick: () => {} }], []]} />,
    );
    expect(dividers(container)).toBe(0);
  });

  it("expands one submenu at a time, across groups", () => {
    render(
      <MenuPanel
        left={0}
        top={0}
        onClose={() => {}}
        groups={[
          [{ label: "First group", submenu: [{ label: "A", onClick: () => {} }] }],
          [{ label: "Second group", submenu: [{ label: "B", onClick: () => {} }] }],
        ]}
      />,
    );
    // Both are their group's first row; a per-group index would collide and
    // expand both at once.
    fireEvent.click(screen.getByRole("menuitem", { name: "Second group" }));
    expect(screen.getByRole("menuitem", { name: "B" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "A" })).not.toBeInTheDocument();
  });

  it("renders a shortcut as key-cap badges hidden from the accessible name", () => {
    render(
      <MenuPanel
        left={0}
        top={0}
        onClose={() => {}}
        groups={[[{ label: "AI actions…", shortcut: ShortcutId.AiActions, onClick: () => {} }]]}
      />,
    );
    expectShortcut("AI actions…", ShortcutId.AiActions);
  });
});
