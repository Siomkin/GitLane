// CommitContextMenu (GL-159): the batch-selection menu (cherry-pick/revert
// ordering via buildCommitBatchPlan, squash eligibility + seeded message, the
// inclusive compare range), the reset submenu's headPrecondition wiring (GL-42),
// and the reword-HEAD gate (unpushed commits only).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CommitNode, RepoGraph } from "../../../../lib/api";
import { useNotifications } from "../../../../store/notifications";
import { useRepo } from "../../../../store/repo";
import { useUi } from "../../../../store/ui";
import { CommitContextMenu } from "./CommitContextMenu";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const realCherryPickMany = useRepo.getState().cherryPickMany;
const realRevertMany = useRepo.getState().revertMany;
const realSquashSelection = useRepo.getState().squashSelection;
const realAmendHeadMessage = useRepo.getState().amendHeadMessage;
const realResetCurrentTo = useRepo.getState().resetCurrentTo;
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
      return Promise.resolve({ summary: "Impact summary", details: [], warnings: [] });
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
    resetCurrentTo: realResetCurrentTo,
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

  it("never opens the reset confirm when HEAD moves while the preview is pending (GL-42)", async () => {
    const resetCurrentTo = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ resetCurrentTo });
    let resolvePreview!: (v: { summary: string; details: string[]; warnings: string[] }) => void;
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

    openGroup("Danger zone");
    fireEvent.click(screen.getByRole("menuitem", { name: "Mixed — keep changes unstaged" }));
    // The originating menu closes before the preview settles (no resurrection).
    await waitFor(() => expect(useUi.getState().commitMenu).toBeNull());

    // HEAD moves while the preview IPC is still in flight.
    useRepo.setState({ summary: { ...summary, headOid: "moved000" } });
    resolvePreview({ summary: "Impact summary", details: [], warnings: [] });

    await waitFor(() =>
      expect(useNotifications.getState().toasts.slice(-1)[0]?.title).toContain("HEAD changed"),
    );
    expect(useUi.getState().confirm).toBeNull();
    expect(resetCurrentTo).not.toHaveBeenCalled();
  });

  it("aborts a reset confirmed after HEAD moved (headPrecondition, GL-42)", async () => {
    const resetCurrentTo = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ resetCurrentTo });
    openSingle("c2abcdef");
    render(<CommitContextMenu />);

    openGroup("Danger zone");
    fireEvent.click(screen.getByRole("menuitem", { name: "Soft — keep changes staged" }));
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
    expect(invokeMock).toHaveBeenCalledWith("preview_reset", expect.objectContaining({ target: "c2abcdef" }));

    // A commit/checkout lands between preview and confirm: HEAD no longer
    // matches the precondition captured at menu time.
    useRepo.setState({ summary: { ...summary, headOid: "moved000" } });
    useUi.getState().confirm!.onConfirm();

    expect(resetCurrentTo).not.toHaveBeenCalled();
    expect(
      useNotifications.getState().toasts.some((t) => t.title.includes("HEAD changed")),
    ).toBe(true);
  });

  it("runs the reset when HEAD still matches the precondition", async () => {
    const resetCurrentTo = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ resetCurrentTo });
    openSingle("c2abcdef");
    render(<CommitContextMenu />);

    openGroup("Danger zone");
    fireEvent.click(screen.getByRole("menuitem", { name: "Hard — discard changes" }));
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
    expect(useUi.getState().confirm?.danger).toBe(true);
    useUi.getState().confirm!.onConfirm();
    await waitFor(() => expect(resetCurrentTo).toHaveBeenCalledWith("c2abcdef", "hard"));
  });

  it("offers Edit commit message… only for an unpushed HEAD commit", () => {
    openSingle("c1abcdef");
    render(<CommitContextMenu />);
    openGroup("Danger zone");
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
    openGroup("Danger zone");
    expect(screen.queryByRole("menuitem", { name: "Edit commit message…" })).not.toBeInTheDocument();
  });

  it("hides the reword for a non-HEAD commit", () => {
    openSingle("c2abcdef");
    render(<CommitContextMenu />);
    openGroup("Danger zone");
    expect(screen.queryByRole("menuitem", { name: "Edit commit message…" })).not.toBeInTheDocument();
  });

  it("reword prefills the current message and amends with the split subject/body", () => {
    const amendHeadMessage = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ amendHeadMessage });
    openSingle("c1abcdef");
    render(<CommitContextMenu />);
    openGroup("Danger zone");
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit commit message…" }));

    const prompt = useUi.getState().prompt;
    expect(prompt?.defaultValue).toBe("feat: c1abcdef");
    prompt!.onSubmit("fix: better subject\n\nlonger body");
    expect(amendHeadMessage).toHaveBeenCalledWith("fix: better subject", "longer body");
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

  it("hides squash and the compare range for a non-contiguous selection", () => {
    openBatch(["c1abcdef", "c3abcdef"]);
    render(<CommitContextMenu />);
    expect(screen.queryByRole("menuitem", { name: /Squash/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Compare/ })).not.toBeInTheDocument();
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
    expect(useNotifications.getState().toasts.some((t) => t.title === "Copied 2 SHAs")).toBe(true);
    expect(useUi.getState().commitMenu).toBeNull();
  });
});
