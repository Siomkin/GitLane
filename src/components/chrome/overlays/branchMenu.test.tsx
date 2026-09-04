import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRepo } from "@/store/repo";
import { useUi, contextMenuOf, MenuKind } from "@/store/ui";
import { useNotifications } from "@/store/notifications";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { isMac } from "@/lib/platform";
import { ShortcutId, shortcutParts } from "@/lib/shortcuts";
import { BranchContextMenu, WorktreeContextMenu } from "./menus";

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

describe("BranchContextMenu", () => {
  it("renders nothing until a branch menu is open", () => {
    const { container } = render(<BranchContextMenu />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows Push and Pull shortcut badges only on the current branch", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "h", detached: false },
      branches: [
        { ...localBranch("main"), isHead: true },
        localBranch("feature"),
      ],
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "main", isCurrent: true } } });
    const { unmount } = render(<BranchContextMenu />);
    expectShortcut("Pull (fast-forward only)", ShortcutId.Pull);
    expectShortcut("Push", ShortcutId.Push);
    unmount();

    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);
    expectNoShortcut("Push feature");
  });

  it("offers Delete (inside Danger zone) for a local non-current branch", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "h", detached: false },
      branches: [localBranch("main"), localBranch("feature")],
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);
    // Reset stays at the first level (same depth as the commit menu), never
    // buried inside Danger zone.
    expect(screen.getByRole("menuitem", { name: "Reset main to feature" })).toBeInTheDocument();
    openGroup("Danger zone");
    expect(screen.getByRole("menuitem", { name: "Delete feature" })).toBeInTheDocument();
    // The reset modes are not inside Danger zone.
    expect(screen.queryByRole("menuitem", { name: "Soft — keep changes staged" })).not.toBeInTheDocument();
  });

  it("mirrors the commit menu: Cherry-pick/Revert flat, branch integrate verbs in a fan", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);

    // Same as the commit menu: Cherry-pick/Revert are promoted flat rows acting
    // on the tip; Merge/Rebase fold into the Integrate fan.
    expect(screen.getByRole("menuitem", { name: "Cherry-pick onto main" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Revert commit" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Merge feature" })).not.toBeInTheDocument();
    openGroup("Integrate into current");
    expect(screen.getByRole("menuitem", { name: "Merge feature" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Rebase onto feature" })).toBeInTheDocument();

    // Single-open: opening Compare collapses Integrate.
    openGroup("Compare");
    expect(screen.queryByRole("menuitem", { name: "Merge feature" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Compare with branch…" })).toBeInTheDocument();
  });

  it("confirms before reverting the branch tip", () => {
    // Revert commits straight to the checked-out branch, so the flat row raises
    // a confirm naming the tip and that branch (same gate as the commit menu).
    const revertCommit = vi.fn().mockResolvedValue("ok");
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
      revertCommit,
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Revert commit" }));
    expect(revertCommit).not.toHaveBeenCalled();
    const confirm = useUi.getState().confirm;
    expect(confirm?.title).toBe("Revert commit abc1234?");
    expect(confirm?.message).toContain('"main"');
    confirm!.onConfirm();
    expect(revertCommit).toHaveBeenCalledWith("abc1234");
  });

  // The onto-current ops are self-no-ops on the current branch and must stay
  // hidden even when the summary reports a null headOid (unborn / odd state) —
  // the self gate keys off isCurrent / name match, not only the oid.
  it("hides onto-current ops on the current branch even when headOid is null", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "feature", headOid: null, detached: false },
      branches: [localBranch("feature")],
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: true } } });
    render(<BranchContextMenu />);

    expect(screen.queryByRole("menuitem", { name: /^Cherry-pick/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Integrate into current" })).not.toBeInTheDocument();
    // Reverting the current tip is still meaningful, so Revert stays.
    expect(screen.getByRole("menuitem", { name: "Revert commit" })).toBeInTheDocument();
  });

  // Create/compare lead (the everyday create + inspect verbs); the integrate
  // cluster (Cherry-pick/Integrate/Revert) is tucked just above Reset / Danger
  // zone at the bottom, so Revert sits next to Reset.
  it("orders the sections create → compare → integrate → reset → danger", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("main"), localBranch("feature")],
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);

    const rows = ["Create branch here…", "Compare", "Cherry-pick onto main", "Reset main to feature", "Danger zone"].map((name) =>
      screen.getByRole("menuitem", { name }),
    );
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i].compareDocumentPosition(rows[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  // The integrate cluster (Cherry-pick, Integrate into current, Revert) sits
  // immediately above Reset, with no other row in between — Revert is its last
  // row, landing directly next to Reset at the bottom of the menu.
  it("keeps the integrate cluster directly above Reset, with Revert last", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("main"), localBranch("feature")],
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);

    const names = screen.getAllByRole("menuitem").map((el) => el.textContent);
    const cherryPickIdx = names.findIndex((t) => t?.startsWith("Cherry-pick onto main"));
    const integrateIdx = names.findIndex((t) => t?.startsWith("Integrate into current"));
    const revertIdx = names.findIndex((t) => t === "Revert commit");
    const resetIdx = names.findIndex((t) => t?.startsWith("Reset main to feature"));
    expect(cherryPickIdx).toBeGreaterThanOrEqual(0);
    // Cherry-pick → Integrate submenu → Revert last, immediately above Reset.
    expect(cherryPickIdx).toBeLessThan(integrateIdx);
    expect(integrateIdx).toBeLessThan(revertIdx);
    expect(revertIdx + 1).toBe(resetIdx);
  });

  // The branch pill sits on its tip commit, so its menu carries the same
  // commit-level actions as the commit menu on that row, plus View on <forge>.
  it("carries the commit menu's actions plus a forge link for a published branch", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "h", detached: false },
      branches: [localBranch("main"), { ...localBranch("feature"), upstream: "origin/feature", upstreamRemote: "origin" }],
      forge: { hasRemote: true, kind: "github", forge: "GitHub", host: "github.com", webUrl: "https://github.com/o/r" },
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);

    // Same commit-level verbs the commit menu shows on this row.
    expect(screen.getByRole("menuitem", { name: "Cherry-pick onto main" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Revert commit" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Reset main to feature" })).toBeInTheDocument();
    // A published branch on a known forge gets View on <forge>, like the commit menu.
    expect(screen.getByRole("menuitem", { name: "View on GitHub" })).toBeInTheDocument();
    // Review lives in the right panel and isn't repeated; Copy stays (a branch's
    // name isn't surfaced in the right panel).
    expect(screen.queryByRole("menuitem", { name: "Review all changes" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy branch name" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy tip SHA" })).toBeInTheDocument();
    // Patch creation lives in the Create fan, as on the commit menu.
    openGroup("Create");
    expect(screen.getByRole("menuitem", { name: "Patch from commit" })).toBeInTheDocument();
  });

  it("hides the forge link for an unpublished branch", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "h", detached: false },
      branches: [localBranch("main"), localBranch("feature")], // no upstream → unpublished
      forge: { hasRemote: true, kind: "github", forge: "GitHub", host: "github.com", webUrl: "https://github.com/o/r" },
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);
    expect(screen.queryByRole("menuitem", { name: /View on/ })).not.toBeInTheDocument();
  });

  it("links the forge to the upstream's branch, not the local ref name", async () => {
    const opened: string[] = [];
    vi.stubGlobal("open", (url: string) => { opened.push(url); return null; });
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "h", detached: false },
      // Local `feature-x` tracks origin/main → its forge page is /tree/main.
      branches: [localBranch("main"), { ...localBranch("feature-x"), upstream: "origin/main", upstreamRemote: "origin" }],
      forge: { hasRemote: true, kind: "github", forge: "GitHub", host: "github.com", webUrl: "https://github.com/o/r" },
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature-x", isCurrent: false } } });
    render(<BranchContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "View on GitHub" }));
    expect(opened[0]).toBe("https://github.com/o/r/tree/main");
    vi.unstubAllGlobals();
  });

  it("hides the forge link when the upstream is stale (remote branch deleted → would 404)", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "h", detached: false },
      branches: [
        localBranch("main"),
        { ...localBranch("feature"), upstream: "origin/feature", upstreamRemote: "origin", sync: { status: "staleUpstream", upstream: "origin/feature", ahead: 0, behind: 0 } },
      ],
      forge: { hasRemote: true, kind: "github", forge: "GitHub", host: "github.com", webUrl: "https://github.com/o/r" },
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);
    expect(screen.queryByRole("menuitem", { name: /View on/ })).not.toBeInTheDocument();
  });

  // Worktree *creation* is a create verb, so "New worktree here…" lives under
  // Create; managing an existing worktree lives on the worktree pill.
  it("offers New worktree here… under Create", async () => {
    const createWorktreeAt = vi.fn().mockResolvedValue("created");
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
      createWorktreeAt,
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);

    // No standalone worktree management group on the branch menu anymore.
    expect(screen.queryByRole("menuitem", { name: "Worktree" })).not.toBeInTheDocument();
    // Branch creation is a promoted flat row; worktree creation is under Create.
    expect(screen.getByRole("menuitem", { name: "Create branch here…" })).toBeInTheDocument();

    openGroup("Create");
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);

    openGroup("Create");
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
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

  it("stops re-probing fast-forward and drops it when live HEAD moves onto the open menu branch", async () => {
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: opening } });
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

    expect(contextMenuOf(useUi.getState())).toBe(opening);
    // Fast-forward-to-self is impossible, so that row drops...
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "Fast-forward to branch-a" })).not.toBeInTheDocument(),
    );
    // ...and the probe is never re-run for the self-pair.
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "origin/feature", isCurrent: false } } });
    render(<BranchContextMenu />);

    // With the ref unresolvable there's no tip, so every commit-level action
    // (which all act on that tip, exactly like the commit menu) fails closed and
    // vanishes — integrate, cherry-pick, merge, reset — never acting on whichever
    // duplicate match came first.
    expect(screen.queryByRole("menuitem", { name: "Integrate into current" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Cherry-pick/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Merge origin/feature" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Reset / })).not.toBeInTheDocument();
    // The local/remote delete items are kind-derived too, so the Danger zone
    // group disappears as well.
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "origin/feature", isCurrent: false } } });
    render(<BranchContextMenu />);

    expect(invokeMock).not.toHaveBeenCalledWith("can_fast_forward", expect.anything());
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: true } } });
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "main", isCurrent: true } } });

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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });

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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "main", isCurrent: true } } });

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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "main", isCurrent: true } } });

    render(<BranchContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Push" }));

    const prompt = useUi.getState().prompt;
    expect(prompt?.title).toBe("Publish main");
    expect(prompt?.defaultValue).toBe("origin/main");
  });

  // A branch checked out in a linked worktree shows as a branch pill with no
  // separate worktree pill, so the branch menu is the only place to manage that
  // worktree: Open worktree promoted on top, and a Worktree ▸ group holding
  // check-out-here / copy-path / hand-off / remove.
  it("keeps worktree management on the branch menu for a linked-worktree branch", () => {
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
      worktrees: [
        { name: "repo", path: "/work/repo", branch: "main", isMain: true },
        { name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false },
      ],
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);
    // Open worktree is promoted to the top.
    expect(screen.getByRole("menuitem", { name: "Open worktree" })).toBeInTheDocument();
    // Checkout stays hidden: offering it would only produce a git worktree error.
    expect(screen.queryByRole("menuitem", { name: "Checkout feature" })).not.toBeInTheDocument();
    // Worktree creation is under Create.
    openGroup("Create");
    expect(screen.getByRole("menuitem", { name: "New worktree here…" })).toBeInTheDocument();
    // The Worktree fan carries copy-path / hand-off / remove.
    openGroup("Worktree");
    expect(screen.getByRole("menuitem", { name: "Copy worktree path" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Hand off to…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remove worktree" })).toBeInTheDocument();
    // The reclaim entry hands the branch off from its holding worktree.
    fireEvent.click(screen.getByRole("menuitem", { name: "Check out here…" }));
    expect(useUi.getState().handoff).toMatchObject({
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);
    openGroup("Worktree");
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);
    // Open the fan first — the items live inside the collapsed Worktree submenu,
    // so asserting absence without expanding it would pass hollowly.
    openGroup("Worktree");
    expect(screen.queryByRole("menuitem", { name: "Check out here…" })).not.toBeInTheDocument();
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
    useUi.setState({ menu: { kind: MenuKind.Worktree, state: { x: 10, y: 10, path: "/work/repo-feature", name: "repo-feature", isMain: false } } });
    render(<WorktreeContextMenu />);
    expect(screen.queryByRole("menuitem", { name: "Hand off branch to…" })).not.toBeInTheDocument();
  });

  // The promoted "Check out here…" is hidden when no *valid* destination exists —
  // the only other worktree here is the bare main repo, which can't receive a
  // checkout.
  it("hides Check out here… when the only other worktree is bare", () => {
    useRepo.setState({
      summary: { path: "/work/bare.git", workdir: "/work/bare.git", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
      worktrees: [
        { name: "bare.git", path: "/work/bare.git", branch: null, isMain: true, bare: true },
        { name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false },
      ],
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);
    openGroup("Worktree");
    expect(screen.queryByRole("menuitem", { name: "Check out here…" })).not.toBeInTheDocument();
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
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

  // Removing a worktree while keeping its branch also lives in the branch menu's
  // Worktree fan (a linked-worktree branch shows as a branch pill with no separate
  // worktree pill), sharing the worktree row's probe-then-confirm — see the case
  // below and the WorktreeContextMenu tests.
  it("removes a linked worktree from the Worktree fan via the shared probe-then-confirm", async () => {
    const previewRemoveWorktree = vi.fn().mockResolvedValue({
      branch: "feature",
      headOid: "abc1234",
      locked: false,
      dirty: false,
      requiresForce: false,
      expectedState: "worktree-removal-lease-v1",
      details: [],
      warnings: [],
    });
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: null, detached: false },
      branches: [localBranch("feature")],
      worktrees: [
        { name: "repo", path: "/work/repo", branch: "main", isMain: true },
        { name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false },
      ],
      previewRemoveWorktree,
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);

    openGroup("Worktree");
    expect(screen.getByRole("menuitem", { name: "Copy worktree path" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }));
    // Routes through the shared leased-removal probe before any confirm fires.
    await waitFor(() => expect(previewRemoveWorktree).toHaveBeenCalledWith("/work/repo-feature"));
    await waitFor(() => expect(useUi.getState().confirm?.danger).toBe(true));
  });

  // Git refuses to remove the main worktree, so a branch checked out there gets
  // no Remove entry in the fan (canRemoveWorktree is false).
  it("hides Remove worktree in the fan for a main-worktree branch", () => {
    useRepo.setState({
      summary: { path: "/work/other", workdir: "/work/other", headBranch: "other", headOid: null, detached: false },
      branches: [localBranch("feature")],
      worktrees: [{ name: "repo", path: "/work/repo", branch: "feature", isMain: true }],
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);
    openGroup("Worktree");
    expect(screen.queryByRole("menuitem", { name: "Remove worktree" })).not.toBeInTheDocument();
  });

  // Git refuses to remove the main worktree, so a branch checked out there keeps
  // the plain disabled Delete (with an accurate reason) and no combined action.
  it("disables Delete with no combined action for a main-worktree branch", () => {
    useRepo.setState({
      summary: { path: "/work/wt", workdir: "/work/wt", headBranch: "wt-branch", headOid: null, detached: false },
      branches: [localBranch("feature")],
      worktrees: [{ name: "repo", path: "/work/repo", branch: "feature", isMain: true }],
    });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);

    openGroup("Danger zone");
    expect(screen.getByRole("menuitem", { name: "Delete feature" })).toBeDisabled();
    expect(screen.getByText("Checked out in the main worktree.")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete feature & worktree…" })).not.toBeInTheDocument();
    // Opening the worktree the branch lives in stays a promoted quick action.
    expect(screen.getByRole("menuitem", { name: "Open worktree" })).toBeInTheDocument();
  });

  // Remote-tracking refs reach the same menu; local-only mutations like Delete
  // are gated on `isLocal` and must not appear.
  it("hides the local Delete for a remote-tracking ref", () => {
    useRepo.setState({ branches: [remoteBranch("origin/feature")] });
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "origin/feature", isCurrent: false } } });
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "origin/feature", isCurrent: false } } });
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "origin/feature", isCurrent: false } } });
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "origin/feature", isCurrent: false } } });
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
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
    useUi.setState({ menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: "feature", isCurrent: false } } });
    render(<BranchContextMenu />);

    openGroup("Reset main to feature");
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
