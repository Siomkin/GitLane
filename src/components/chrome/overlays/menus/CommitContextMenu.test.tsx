// CommitContextMenu (GL-159): the batch-selection menu (cherry-pick/revert
// ordering via buildCommitBatchPlan, squash eligibility + seeded message, the
// inclusive compare range), the reset submenu's headPrecondition wiring (GL-42),
// and the reword-HEAD gate (unpushed commits only).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CommitNode, RepoGraph } from "@/lib/api";
import { isMac } from "@/lib/platform";
import { ShortcutId, shortcutParts } from "@/lib/shortcuts";
import { useNotifications } from "@/store/notifications";
import { useRepo } from "@/store/repo";
import { useUi, commitMenuOf, MenuKind } from "@/store/ui";
import { AiActionScopeKind } from "@/features/agents/ai-actions";
import { CommitContextMenu } from "./CommitContextMenu";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const realCherryPickMany = useRepo.getState().cherryPickMany;
const realRevertMany = useRepo.getState().revertMany;
const realSquashSelection = useRepo.getState().squashSelection;
const realAmendHeadMessage = useRepo.getState().amendHeadMessage;
const realResetBranchTo = useRepo.getState().resetBranchTo;
const realCheckoutBranch = useRepo.getState().checkoutBranch;

const node = (id: string, row: number, parents: string[], over: Partial<CommitNode> = {}): CommitNode => ({
  id,
  shortId: id.slice(0, 7),
  summary: `feat: ${id}`,
  body: "",
  authorName: "a",
  authorEmail: "a@example.com",
  timestamp: 1000 - row,
  parents,
  lane: 0,
  row,
  refs: [],
  ...over,
});

// Newest-first, a straight first-parent chain: c1 (HEAD) → c2 → c3 → c4.
const chain = (): CommitNode[] => [
  node("c1abcdef", 0, ["c2abcdef"]),
  node("c2abcdef", 1, ["c3abcdef"]),
  node("c3abcdef", 2, ["c4abcdef"]),
  node("c4abcdef", 3, []),
];

const graphOf = (commits: CommitNode[], head = "c1abcdef"): RepoGraph => ({
  commits,
  edges: [],
  laneCount: 1,
  head,
  truncated: false,
});

const summary = {
  path: "/work/repo",
  workdir: "/work/repo",
  headBranch: "main",
  headOid: "c1abcdef",
  detached: false,
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd.startsWith("preview_")) {
      return Promise.resolve({
        summary: "Impact summary",
        details: [],
        warnings: [],
        targetOid: "c2abcdef",
        expectedSourceOid: "c1abcdef",
        expectedState: cmd.includes("reset") ? "v1:test-lease" : null,
        expectedHeadBranch: "main",
        expectedHeadOid: "c1abcdef",
      });
    }
    return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
  });
  useRepo.setState({
    summary,
    graph: graphOf(chain()),
    selectedCommit: null,
    selectedCommits: [],
    wipSelected: false,
    selectionDiff: null,
    cherryPickMany: realCherryPickMany,
    revertMany: realRevertMany,
    squashSelection: realSquashSelection,
    amendHeadMessage: realAmendHeadMessage,
    resetBranchTo: realResetBranchTo,
    checkoutBranch: realCheckoutBranch,
  });
  useUi.setState({
    menu: null,
    confirm: null,
    prompt: null,
    editCommitMessage: null,
    stackedReview: null,
    aiActions: null,
  });
  useNotifications.setState({ toasts: [] });
});

const openSingle = (sha: string) =>
  useUi.setState({ menu: { kind: MenuKind.Commit, state: { x: 10, y: 10, sha, shortSha: sha.slice(0, 7) } } });

const openBatch = (selection: string[]) =>
  useUi.setState({
    menu: { kind: MenuKind.Commit, state: { x: 10, y: 10, sha: selection[0], shortSha: selection[0].slice(0, 7), selection } },
  });

const openGroup = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("menuitem", { name }));

describe("CommitContextMenu (single commit)", () => {
  it("renders nothing until a commit menu is open", () => {
    const { container } = render(<CommitContextMenu />);
    expect(container).toBeEmptyDOMElement();
  });

  // Create/compare lead (the everyday create + inspect verbs); the integrate
  // cluster (cherry-pick/integrate/revert) is tucked just above the
  // danger-toned reset at the bottom, so Revert sits next to Reset.
  it("orders the flat groups create → compare → integrate → reset", () => {
    openSingle("c2abcdef");
    render(<CommitContextMenu />);

    const rows = [
      "Create branch here…",
      "Compare",
      "Cherry-pick onto main",
      "Revert commit",
      "Reset main to here",
    ].map((name) => screen.getByRole("menuitem", { name }));
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i].compareDocumentPosition(rows[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  // The integrate cluster sits immediately above Reset — Cherry-pick →
  // Integrate submenu → Revert last, directly preceding Reset.
  it("keeps the integrate cluster directly above Reset, with Revert last", () => {
    openSingle("c2abcdef");
    render(<CommitContextMenu />);

    const names = screen.getAllByRole("menuitem").map((el) => el.textContent);
    const cherryPickIdx = names.findIndex((t) => t?.startsWith("Cherry-pick onto main"));
    const integrateIdx = names.findIndex((t) => t?.startsWith("Integrate into current"));
    const revertIdx = names.findIndex((t) => t === "Revert commit");
    const resetIdx = names.findIndex((t) => t?.startsWith("Reset main to here"));
    expect(cherryPickIdx).toBeGreaterThanOrEqual(0);
    expect(cherryPickIdx).toBeLessThan(integrateIdx);
    expect(integrateIdx).toBeLessThan(revertIdx);
    expect(revertIdx + 1).toBe(resetIdx);
  });

  it("folds the rarer create targets into the Create submenu", () => {
    openSingle("c2abcdef");
    render(<CommitContextMenu />);

    // Branch creation is a flat row; the rest live under "Create".
    expect(screen.getByRole("menuitem", { name: "Create branch here…" })).toBeInTheDocument();
    openGroup("Create");
    expect(screen.getByRole("menuitem", { name: "Tag here…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Annotated tag here…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Worktree at commit…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Worktree with branch…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Patch from commit" })).toBeInTheDocument();
  });

  it("never opens the reset confirm when HEAD moves while the preview is pending (GL-42)", async () => {
    const resetBranchTo = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ resetBranchTo });
    let resolvePreview!: (v: Record<string, unknown>) => void;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "preview_reset") {
        return new Promise((res) => {
          resolvePreview = res;
        });
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    openSingle("c2abcdef");
    render(<CommitContextMenu />);

    openGroup("Reset main to here");
    fireEvent.click(screen.getByRole("menuitem", { name: "Mixed — keep changes unstaged" }));
    // The originating menu closes before the preview settles (no resurrection).
    await waitFor(() => expect(commitMenuOf(useUi.getState())).toBeNull());

    // HEAD moves while the preview IPC is still in flight.
    useRepo.setState({ summary: { ...summary, headOid: "moved000" } });
    resolvePreview({
      summary: "Impact summary",
      details: [],
      warnings: [],
      targetOid: "c2abcdef",
      expectedSourceOid: "c1abcdef",
      expectedState: null,
      expectedHeadBranch: "main",
      expectedHeadOid: "c1abcdef",
    });

    await waitFor(() =>
      expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toContain("HEAD changed"),
    );
    expect(useUi.getState().confirm).toBeNull();
    expect(resetBranchTo).not.toHaveBeenCalled();
  });

  it("aborts a reset confirmed after HEAD moved (headPrecondition, GL-42)", async () => {
    const resetBranchTo = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ resetBranchTo });
    openSingle("c2abcdef");
    render(<CommitContextMenu />);

    openGroup("Reset main to here");
    fireEvent.click(screen.getByRole("menuitem", { name: "Soft — keep changes staged" }));
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
    expect(invokeMock).toHaveBeenCalledWith("preview_reset", expect.objectContaining({ target: "c2abcdef" }));

    // A commit/checkout lands between preview and confirm: HEAD no longer
    // matches the precondition captured at menu time.
    useRepo.setState({ summary: { ...summary, headOid: "moved000" } });
    useUi.getState().confirm!.onConfirm();

    expect(resetBranchTo).not.toHaveBeenCalled();
    expect(
      useNotifications.getState().toasts.some((t) => t.title.includes("HEAD changed")),
    ).toBe(true);
  });

  it("runs the reset when HEAD still matches the precondition", async () => {
    const resetBranchTo = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ resetBranchTo });
    openSingle("c2abcdef");
    render(<CommitContextMenu />);

    openGroup("Reset main to here");
    fireEvent.click(screen.getByRole("menuitem", { name: "Hard — discard changes" }));
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
    expect(useUi.getState().confirm?.danger).toBe(true);
    useUi.getState().confirm!.onConfirm();
    await waitFor(() =>
      expect(resetBranchTo).toHaveBeenCalledWith(
        "main",
        "c2abcdef",
        "hard",
        expect.objectContaining({
          targetOid: "c2abcdef",
          expectedState: "v1:test-lease",
        }),
      ),
    );
  });

  // The confirm names both operands, and names them the way the row does: the
  // branch label falls back to "HEAD" when detached, where the `resetBranchTo`
  // branch operand is legitimately null (GL-359 — one field for both printed
  // "Reset null to here?").
  it("names the branch and the target commit in the reset confirm", async () => {
    useRepo.setState({ resetBranchTo: vi.fn().mockResolvedValue("ok") });
    openSingle("c2abcdef");
    render(<CommitContextMenu />);

    openGroup("Reset main to here");
    fireEvent.click(screen.getByRole("menuitem", { name: "Soft — keep changes staged" }));
    await waitFor(() => expect(useUi.getState().confirm?.title).toBe("Reset main to c2abcde?"));
  });

  it("spells a detached HEAD as HEAD in the reset confirm, not null", async () => {
    const resetBranchTo = vi.fn().mockResolvedValue("ok");
    useRepo.setState({
      resetBranchTo,
      summary: { ...summary, headBranch: null, detached: true },
    });
    openSingle("c2abcdef");
    render(<CommitContextMenu />);

    openGroup("Reset HEAD to here");
    fireEvent.click(screen.getByRole("menuitem", { name: "Soft — keep changes staged" }));
    await waitFor(() => expect(useUi.getState().confirm?.title).toBe("Reset HEAD to c2abcde?"));
    // The op operand stays null — only the label falls back.
    useUi.getState().confirm!.onConfirm();
    await waitFor(() =>
      expect(resetBranchTo).toHaveBeenCalledWith(null, "c2abcdef", "soft", expect.anything()),
    );
  });

  it("offers Edit commit message… only for an unpushed HEAD commit", () => {
    openSingle("c1abcdef");
    render(<CommitContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Edit commit message…" })).toBeInTheDocument();
  });

  it("hides the reword when the HEAD commit is reachable from a remote ref", () => {
    const commits = chain();
    commits[0] = node("c1abcdef", 0, ["c2abcdef"], {
      refs: [{ name: "origin/main", kind: "remote" }],
    });
    useRepo.setState({ graph: graphOf(commits) });
    openSingle("c1abcdef");
    render(<CommitContextMenu />);
    expect(screen.queryByRole("menuitem", { name: "Edit commit message…" })).not.toBeInTheDocument();
  });

  it("hides the reword for a non-HEAD commit", () => {
    openSingle("c2abcdef");
    render(<CommitContextMenu />);
    expect(screen.queryByRole("menuitem", { name: "Edit commit message…" })).not.toBeInTheDocument();
  });

  it("reword prefills the current message and amends with the split subject/body", () => {
    const amendHeadMessage = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ amendHeadMessage });
    openSingle("c1abcdef");
    render(<CommitContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit commit message…" }));

    const request = useUi.getState().editCommitMessage;
    expect(request?.defaultValue).toBe("feat: c1abcdef");
    request!.onSubmit("fix: better subject\n\nlonger body");
    expect(amendHeadMessage).toHaveBeenCalledWith("fix: better subject", "longer body");
  });

  it("shows View on <forge> only for a commit reachable from a remote", () => {
    const commits = chain();
    // origin/main at the tip → every ancestor is on the remote.
    commits[0] = node("c1abcdef", 0, ["c2abcdef"], { refs: [{ name: "origin/main", kind: "remote" }] });
    useRepo.setState({
      graph: graphOf(commits),
      forge: { hasRemote: true, kind: "github", forge: "GitHub", host: "github.com", webUrl: "https://github.com/o/r" },
    });
    openSingle("c2abcdef");
    render(<CommitContextMenu />);

    expect(screen.getByRole("menuitem", { name: "View on GitHub" })).toBeInTheDocument();
  });

  it("hides the forge affordance for an unpushed commit", () => {
    useRepo.setState({
      forge: { hasRemote: true, kind: "github", forge: "GitHub", host: "github.com", webUrl: "https://github.com/o/r" },
    });
    openSingle("c2abcdef"); // default chain has no remote refs → unpushed
    render(<CommitContextMenu />);

    expect(screen.queryByRole("menuitem", { name: /View on/ })).not.toBeInTheDocument();
  });

  it("keeps review out of the menu but offers the Copy cluster", () => {
    openSingle("c2abcdef");
    render(<CommitContextMenu />);
    // Review lives in the right panel; Copy stays in the menu.
    expect(screen.queryByRole("menuitem", { name: "Review all changes" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy commit SHA" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy" })).toBeInTheDocument();
  });

  it("hides the onto-current ops on the HEAD commit (self-ops), keeping Revert", () => {
    openSingle("c1abcdef"); // c1abcdef is graph.head
    render(<CommitContextMenu />);
    // Cherry-pick/merge/rebase onto HEAD are no-ops (cherry-pick would leave an
    // empty sequence), so they're hidden; Revert stays.
    expect(screen.queryByRole("menuitem", { name: /^Cherry-pick/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Integrate into current" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Revert commit" })).toBeInTheDocument();
  });

  it("confirms before reverting a commit", () => {
    // Revert sits one row from Cherry-pick and Reset and commits straight to the
    // checked-out branch, so a mis-aimed click must not write history.
    const revertCommit = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ revertCommit });
    openSingle("c2abcdef");
    render(<CommitContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Revert commit" }));
    expect(revertCommit).not.toHaveBeenCalled();
    const confirm = useUi.getState().confirm;
    expect(confirm?.title).toBe("Revert commit c2abcde?");
    // The message names the branch the new commit lands on.
    expect(confirm?.message).toContain('"main"');
    expect(confirm?.confirmLabel).toBe("Revert");
    // Revert adds history rather than destroying it — not danger-toned.
    expect(confirm?.danger).toBeFalsy();
    confirm!.onConfirm();
    expect(revertCommit).toHaveBeenCalledWith("c2abcdef");
  });

  it("offers the onto-current ops on a non-HEAD commit", () => {
    openSingle("c2abcdef");
    render(<CommitContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Cherry-pick onto main" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Integrate into current" })).toBeInTheDocument();
  });

  it("opens AI actions for the clicked commit", () => {
    openSingle("c2abcdef");
    render(<CommitContextMenu />);
    const item = screen.getByRole("menuitem", { name: "AI actions…" });
    for (const part of shortcutParts(ShortcutId.AiActions, isMac)) {
      expect(within(item).getByText(part)).toBeInTheDocument();
    }
    fireEvent.click(item);
    expect(useUi.getState().aiActions).toEqual({
      kind: AiActionScopeKind.Commits,
      commits: ["c2abcdef"],
    });
    expect(useUi.getState().menu).toBeNull();
  });

  it("does not fold WIP in when the clicked commit is outside the selection", () => {
    // wipSelected is global state; right-clicking an unselected commit must not
    // inherit it and scope the run to "commit + uncommitted".
    useRepo.setState({ wipSelected: true, selectedCommits: ["c1abcdef"] });
    openSingle("c2abcdef");
    render(<CommitContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "AI actions…" }));
    expect(useUi.getState().aiActions).toEqual({
      kind: AiActionScopeKind.Commits,
      commits: ["c2abcdef"],
    });
  });
});

describe("CommitContextMenu (batch selection)", () => {
  it("cherry-picks oldest-first so the commits replay chronologically", () => {
    const cherryPickMany = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ cherryPickMany });
    openBatch(["c1abcdef", "c3abcdef"]);
    render(<CommitContextMenu />);

    expect(screen.getByText("2 commits selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Cherry-pick 2 commits onto main" }));
    expect(cherryPickMany).toHaveBeenCalledWith(["c3abcdef", "c1abcdef"]);
  });

  it("reverts newest-first, after confirmation", () => {
    const revertMany = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ revertMany });
    openBatch(["c1abcdef", "c2abcdef"]);
    render(<CommitContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Revert 2 commits" }));
    // Revert writes commits, so the menu click only raises the confirm.
    expect(revertMany).not.toHaveBeenCalled();
    expect(useUi.getState().confirm?.title).toBe("Revert 2 commits?");
    expect(useUi.getState().confirm?.message).toContain('2 new commits to "main"');
    useUi.getState().confirm!.onConfirm();
    expect(revertMany).toHaveBeenCalledWith(["c1abcdef", "c2abcdef"]);
  });

  it("offers squash for a contiguous unpushed selection at HEAD, seeding the combined message", () => {
    const squashSelection = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ squashSelection });
    openBatch(["c1abcdef", "c2abcdef"]);
    render(<CommitContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Squash 2 commits…" }));
    const prompt = useUi.getState().prompt;
    // Seeded oldest-first so the subject line stays a real subject (hook-safe).
    expect(prompt?.defaultValue).toBe("feat: c2abcdef\n\nfeat: c1abcdef");
    prompt!.onSubmit("feat: squashed");
    expect(squashSelection).toHaveBeenCalledWith(["c1abcdef", "c2abcdef"], "feat: squashed");
  });

  it("offers squash below the tip, saying the commits above are rewritten", () => {
    openBatch(["c2abcdef", "c3abcdef"]);
    render(<CommitContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Squash 2 commits…" }));
    expect(useUi.getState().prompt?.message).toContain("rewritten onto it");
  });

  // Below the tip the rewrite moves a branch ref, so a detached HEAD can only
  // fail in the backend — after the user has written a message.
  it("hides a below-tip squash on a detached HEAD but keeps the one at HEAD", () => {
    useRepo.setState({ summary: { ...summary, headBranch: null, detached: true } });
    openBatch(["c2abcdef", "c3abcdef"]);
    const below = render(<CommitContextMenu />);
    expect(screen.queryByRole("menuitem", { name: /Squash/ })).not.toBeInTheDocument();
    below.unmount();

    openBatch(["c1abcdef", "c2abcdef"]);
    render(<CommitContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Squash 2 commits…" })).toBeInTheDocument();
  });

  it("hides squash, patch, and the compare range for a non-contiguous selection", () => {
    openBatch(["c1abcdef", "c3abcdef"]);
    render(<CommitContextMenu />);
    expect(screen.queryByRole("menuitem", { name: /Squash/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Create patch/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Compare/ })).not.toBeInTheDocument();
  });

  it("creates a range patch from the contiguous selection's first-parent base..head", () => {
    const createPatchRangeAt = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ createPatchRangeAt });
    openBatch(["c1abcdef", "c2abcdef"]);
    render(<CommitContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Create patch from 2 commits" }));
    // Same inclusive range the compare row uses: oldest's first parent → newest.
    expect(createPatchRangeAt).toHaveBeenCalledWith("c3abcdef", "c1abcdef");
  });

  it("hides squash when the selection includes a pushed commit but keeps cherry-pick/revert", () => {
    const commits = chain();
    commits[0] = node("c1abcdef", 0, ["c2abcdef"], {
      refs: [{ name: "origin/main", kind: "remote" }],
    });
    useRepo.setState({ graph: graphOf(commits) });
    openBatch(["c1abcdef", "c2abcdef"]);
    render(<CommitContextMenu />);
    expect(screen.queryByRole("menuitem", { name: /Squash/ })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Cherry-pick 2 commits onto main" })).toBeInTheDocument();
  });

  it("compares the inclusive range via the oldest commit's first parent", () => {
    openBatch(["c1abcdef", "c2abcdef"]);
    render(<CommitContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Compare c2abcde…c1abcde" }));
    expect(useUi.getState().stackedReview).toMatchObject({
      kind: "range",
      base: "c3abcdef",
      head: "c1abcdef",
    });
  });

  it("copies all selected SHAs newest-first, newline-joined", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    openBatch(["c3abcdef", "c1abcdef"]); // selection order ≠ graph order
    render(<CommitContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy 2 commit SHAs" }));
    // Graph (newest-first) order wins regardless of click order.
    expect(writeText).toHaveBeenCalledWith("c1abcdef\nc3abcdef");
    // A clipboard copy is silent — no "Copied" toast noise (GL-217).
    expect(useNotifications.getState().toasts).toHaveLength(0);
    expect(commitMenuOf(useUi.getState())).toBeNull();
  });

  it("opens AI actions for the selected commits", () => {
    openBatch(["c1abcdef", "c3abcdef"]);
    render(<CommitContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "AI actions…" }));
    expect(useUi.getState().aiActions).toEqual({
      kind: AiActionScopeKind.Commits,
      commits: ["c1abcdef", "c3abcdef"],
    });
  });
});
