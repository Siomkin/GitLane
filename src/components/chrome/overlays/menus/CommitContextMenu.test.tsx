// CommitContextMenu (GL-159): the batch-selection menu (cherry-pick/revert
// ordering via buildCommitBatchPlan, squash eligibility + seeded message, the
// inclusive compare range), the reset submenu's headPrecondition wiring (GL-42),
// and the reword-HEAD gate (unpushed commits only).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CommitNode, RepoGraph } from "@/lib/api";
import { useNotifications } from "@/store/notifications";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
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
  color: 0,
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
    cherryPickMany: realCherryPickMany,
    revertMany: realRevertMany,
    squashSelection: realSquashSelection,
    amendHeadMessage: realAmendHeadMessage,
    resetBranchTo: realResetBranchTo,
    checkoutBranch: realCheckoutBranch,
  });
  useUi.setState({ commitMenu: null, confirm: null, prompt: null, stackedReview: null });
  useNotifications.setState({ toasts: [] });
});

const openSingle = (sha: string) =>
  useUi.setState({ commitMenu: { x: 10, y: 10, sha, shortSha: sha.slice(0, 7) } });

const openBatch = (selection: string[]) =>
  useUi.setState({
    commitMenu: { x: 10, y: 10, sha: selection[0], shortSha: selection[0].slice(0, 7), selection },
  });

const openGroup = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("menuitem", { name }));

describe("CommitContextMenu (single commit)", () => {
  it("renders nothing until a commit menu is open", () => {
    const { container } = render(<CommitContextMenu />);
    expect(container).toBeEmptyDOMElement();
  });

  // Flat, frequency-ordered: cherry-pick/revert lead, then create, compare,
  // and the danger-toned reset last (ADR 0004).
  it("orders the flat groups integrate → create → compare → reset", () => {
    openSingle("c2abcdef");
    render(<CommitContextMenu />);

    const rows = [
      "Cherry-pick onto main",
      "Revert commit",
      "Create branch here…",
      "Compare",
      "Reset main to here",
    ].map((name) => screen.getByRole("menuitem", { name }));
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i].compareDocumentPosition(rows[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
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
    await waitFor(() => expect(useUi.getState().commitMenu).toBeNull());

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

    const prompt = useUi.getState().prompt;
    expect(prompt?.defaultValue).toBe("feat: c1abcdef");
    prompt!.onSubmit("fix: better subject\n\nlonger body");
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

  it("keeps review and copy out of the menu (they live in the right panel)", () => {
    openSingle("c2abcdef");
    render(<CommitContextMenu />);
    expect(screen.queryByRole("menuitem", { name: "Review all changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /^Copy/ })).not.toBeInTheDocument();
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

  it("offers the onto-current ops on a non-HEAD commit", () => {
    openSingle("c2abcdef");
    render(<CommitContextMenu />);
    expect(screen.getByRole("menuitem", { name: "Cherry-pick onto main" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Integrate into current" })).toBeInTheDocument();
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

  it("reverts newest-first", () => {
    const revertMany = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ revertMany });
    openBatch(["c1abcdef", "c2abcdef"]);
    render(<CommitContextMenu />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Revert 2 commits" }));
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
      range: { base: "c3abcdef", head: "c1abcdef" },
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
    expect(useUi.getState().commitMenu).toBeNull();
  });
});
