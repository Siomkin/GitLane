import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchKind, ForgeKind, RefKind, type BranchInfo, type CommitNode, type FileChange, type RepoForge, type AcpAgent, type TerminalAgent } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { ComposerMode } from "@/lib/conventionalCommit";
import { useAccounts } from "@/store/accounts";
import {
  DEFAULT_COMMIT_AGENT_MESSAGES,
  useCommitAgentMessages,
} from "@/store/commitAgentMessages";
import { useIdentities } from "@/store/identities";
import { useRepo } from "@/store/repo";
import { beginPublishedRepoSession } from "@/store/repoRequests";
import { useAcpAgents } from "@/store/acpAgents";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useUi } from "@/store/ui";
import { CommitComposer } from "./CommitComposer";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const staged = (path: string): FileChange => ({
  path,
  status: "M",
  add: 12,
  del: 3,
  binary: false,
});

const agent = (over: Partial<AcpAgent> = {}): AcpAgent => ({
  id: "codex",
  name: "codex",
  command: "codex-acp",
  model: "",
  config: {},
  description: "",
  enabled: true,
  available: true,
  ...over,
});

/** A terminal agent, for the "Commit with agent" split-button only. */
const tuiAgent = (over: Partial<TerminalAgent> = {}): TerminalAgent => ({
  id: "codex",
  name: "codex",
  command: "codex",
  description: "",
  enabled: true,
  available: true,
  ...over,
});

const commit = (over: Partial<CommitNode> = {}): CommitNode => ({
  id: "head-oid",
  shortId: "abc1234",
  summary: "previous summary",
  body: "",
  authorName: "Ada",
  authorEmail: "ada@example.test",
  timestamp: 1,
  parents: [],
  lane: 0,
  row: 0,
  color: 0,
  refs: [],
  ...over,
});

const localBranch = (over: Partial<BranchInfo> = {}): BranchInfo => ({
  name: "main",
  kind: BranchKind.Local,
  target: "head-oid",
  isHead: true,
  upstream: "origin/main",
  remote: null,
  sync: { status: "upToDate", upstream: "origin/main", ahead: 0, behind: 0 },
  ...over,
});

const githubForge: RepoForge = {
  hasRemote: true,
  kind: ForgeKind.GitHub,
  forge: "GitHub",
  host: "github.com",
  webUrl: "https://github.com/acme/repo",
};

/** The graph that makes amend available: an unpushed head commit. */
const amendableGraph = () => ({
  commits: [commit()],
  edges: [],
  laneCount: 1,
  head: "head-oid",
  truncated: false,
});

const publishedHeadGraph = () => ({
  ...amendableGraph(),
  commits: [commit({ refs: [{ name: "origin/main", kind: RefKind.Remote }] })],
});

const openCommitMenu = () => {
  fireEvent.click(screen.getByRole("button", { name: "More commit actions" }));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Render and expand the composer (it mounts as the collapsed bar). */
const renderComposer = () => {
  render(<CommitComposer />);
  fireEvent.click(screen.getByRole("button", { name: "Expand commit composer" }));
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "default_git_identity") {
      return { name: "Alex Global", email: "alex@example.dev" };
    }
    if (command === "repo_identity") return useAccounts.getState().repoIdentity;
    return null;
  });
  localStorage.clear();
  useAccounts.setState({ repoIdentity: null });
  useIdentities.setState({ manualIdentities: [], defaultIdentity: null });
  useRepo.setState({
    summary: { path: "/repo", workdir: "/repo", headBranch: "main", headOid: "abc", detached: false },
    graph: null,
    forge: null,
    branches: [],
    changes: {
      staged: [staged("src/feature.ts")],
      unstaged: [],
      conflicted: [],
      advanced: emptyAdvancedState,
    },
    commitSelected: vi.fn(async () => true),
    push: vi.fn(async () => {}),
    publishBranch: vi.fn(async () => ""),
  });
  useUi.setState({
    commitMsg: "",
    commitComposerMode: ComposerMode.Conventional,
    commitDraftAgent: null,
    agentCommitDraft: null,
    createPrOpen: false,
    sendToTerminal: vi.fn(),
  });
  useAcpAgents.setState({
    agents: [agent()],
    loading: false,
    error: null,
    loadAgents: vi.fn(async () => {}),
  });
  useTerminalAgents.setState({
    agents: [tuiAgent()],
    loading: false,
    error: null,
    loadAgents: vi.fn(async () => {}),
  });
  useCommitAgentMessages.setState({
    messages: DEFAULT_COMMIT_AGENT_MESSAGES,
    loading: false,
    error: null,
    loadMessages: vi.fn(async () => {}),
  });
});

describe("CommitComposer", () => {
  it("does not steal focus when the composer expands", () => {
    // The reword dialog opts into focus via `autoFocus`; the inline composer
    // must not, or expanding it would yank focus out of whatever the user was
    // doing. Guards the editor both surfaces share.
    renderComposer();

    expect(screen.getByRole("textbox", { name: "Commit summary" })).not.toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Commit body" })).not.toHaveFocus();
  });

  it("renders the structured composer inline and shows the effective identity", async () => {
    renderComposer();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Commit summary" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Commit body" })).toHaveAttribute("rows", "5");
    expect(
      await screen.findByRole("button", {
        name: "Commit identity: Alex Global · alex@example.dev",
      }),
    ).toBeVisible();
  });

  it("composes the conventional fields into the shared commit message", () => {
    renderComposer();

    fireEvent.change(screen.getByRole("combobox", { name: "Commit type" }), {
      target: { value: "feat" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Commit scope" }), {
      target: { value: "changes" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Commit summary" }), {
      target: { value: "move commit controls inline" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Commit body" }), {
      target: { value: "Because inline." },
    });

    expect(useUi.getState().commitMsg).toBe(
      "feat(changes): move commit controls inline\n\nBecause inline.",
    );
    expect(screen.getByText("42/50")).toBeVisible();
  });

  it("parses an externally delivered draft into the structured fields", () => {
    renderComposer();

    act(() => {
      useUi.getState().setCommitMsg("chore(docker): restart services\n\nSet restart policy.");
    });

    expect(screen.getByRole("combobox", { name: "Commit type" })).toHaveValue("chore");
    expect(screen.getByRole("textbox", { name: "Commit scope" })).toHaveValue("docker");
    expect(screen.getByRole("textbox", { name: "Commit summary" })).toHaveValue("restart services");
    expect(screen.getByRole("textbox", { name: "Commit body" })).toHaveValue("Set restart policy.");
  });

  it("carries the message across the Message / Conventional style switch", () => {
    useUi.setState({ commitMsg: "fix(ui): keep the text" });
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveValue(
      "fix(ui): keep the text",
    );

    fireEvent.click(screen.getByRole("button", { name: "Conventional" }));
    expect(screen.getByRole("textbox", { name: "Commit summary" })).toHaveValue("keep the text");
  });

  it("commits the staged set and clears the message only after success", async () => {
    const commitSelected = vi.fn(async () => true);
    useRepo.setState({ commitSelected });
    useUi.setState({ commitMsg: "feat(changes): move commit controls inline" });
    renderComposer();

    fireEvent.click(await screen.findByRole("button", { name: "Commit 1 file → main" }));

    expect(commitSelected).toHaveBeenCalledWith(
      "feat(changes): move commit controls inline",
      false,
    );
    await waitFor(() => expect(useUi.getState().commitMsg).toBe(""));
  });

  it("preserves the message when committing fails", async () => {
    const commitSelected = vi.fn(async () => false);
    useRepo.setState({ commitSelected });
    useUi.setState({ commitMsg: "fix: keep this message" });
    renderComposer();

    fireEvent.click(await screen.findByRole("button", { name: "Commit 1 file → main" }));

    expect(commitSelected).toHaveBeenCalled();
    expect(useUi.getState().commitMsg).toBe("fix: keep this message");
  });

  it("pushes after a successful Commit & push", async () => {
    const push = vi.fn(async () => {});
    useRepo.setState({ push, branches: [localBranch()] });
    useUi.setState({ commitMsg: "fix: something" });
    renderComposer();

    await screen.findByRole("button", { name: /^Commit identity:/ });
    openCommitMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Commit & push" }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(useRepo.getState().commitSelected).toHaveBeenCalledWith("fix: something", false);
  });

  it("routes Commit & push through the publish prompt when there is no upstream", async () => {
    const push = vi.fn(async () => {});
    const requestPrompt = vi.fn();
    useRepo.setState({
      push,
      branches: [
        localBranch({
          upstream: null,
          sync: { status: "noUpstream", upstream: null, ahead: 0, behind: 0 },
        }),
      ],
    });
    useUi.setState({ commitMsg: "fix: something", requestPrompt });
    renderComposer();

    await screen.findByRole("button", { name: /^Commit identity:/ });
    openCommitMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Commit & push" }));

    await waitFor(() => expect(requestPrompt).toHaveBeenCalled());
    expect(requestPrompt.mock.calls[0][0].title).toBe("Publish main");
    expect(push).not.toHaveBeenCalled();
  });

  it("opens the create-PR dialog once Commit, push & open PR has pushed", async () => {
    const push = vi.fn(async () => {});
    useRepo.setState({ push, forge: githubForge, branches: [localBranch()] });
    useUi.setState({ commitMsg: "fix: something" });
    renderComposer();

    await screen.findByRole("button", { name: /^Commit identity:/ });
    openCommitMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Commit, push & open PR…" }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    await waitFor(() => expect(useUi.getState().createPrOpen).toBe(true));
  });

  it("does not open the create-PR dialog when the push did not land", async () => {
    // push() toasts its own failures and resolves; on failure the post-push
    // refresh never runs, so the branch stays `ahead` — the chain must stop.
    const push = vi.fn(async () => {});
    useRepo.setState({
      push,
      forge: githubForge,
      branches: [
        localBranch({ sync: { status: "ahead", upstream: "origin/main", ahead: 1, behind: 0 } }),
      ],
    });
    useUi.setState({ commitMsg: "fix: something" });
    renderComposer();

    await screen.findByRole("button", { name: /^Commit identity:/ });
    openCommitMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Commit, push & open PR…" }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(useUi.getState().createPrOpen).toBe(false);
  });

  it("aborts the push chain when the checkout changes while the commit is in flight", async () => {
    const push = vi.fn(async () => {});
    const commitSelected = vi.fn(async () => {
      useRepo.setState({
        summary: { path: "/other", workdir: "/other", headBranch: "main", headOid: "zzz", detached: false },
      });
      return true;
    });
    useRepo.setState({ push, commitSelected, branches: [localBranch()] });
    useUi.setState({ commitMsg: "fix: something" });
    renderComposer();

    await screen.findByRole("button", { name: /^Commit identity:/ });
    openCommitMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Commit & push" }));

    await waitFor(() => expect(commitSelected).toHaveBeenCalled());
    expect(push).not.toHaveBeenCalled();
  });

  it("toasts a publish failure instead of rejecting unhandled", async () => {
    const publishBranch = vi.fn(async () => {
      throw new Error("publish exploded");
    });
    const requestPrompt = vi.fn();
    const showToast = vi.fn();
    useRepo.setState({
      publishBranch,
      forge: githubForge,
      branches: [
        localBranch({
          upstream: null,
          sync: { status: "noUpstream", upstream: null, ahead: 0, behind: 0 },
        }),
      ],
    });
    useUi.setState({ commitMsg: "fix: something", requestPrompt, showToast });
    renderComposer();

    await screen.findByRole("button", { name: /^Commit identity:/ });
    openCommitMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Commit, push & open PR…" }));

    await waitFor(() => expect(requestPrompt).toHaveBeenCalled());
    await requestPrompt.mock.calls[0][0].onSubmit("origin/main");

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining("publish exploded"), "error"));
    expect(useUi.getState().createPrOpen).toBe(false);
  });

  it("strips parens from the scope so the message always round-trips", () => {
    renderComposer();

    fireEvent.change(screen.getByRole("combobox", { name: "Commit type" }), {
      target: { value: "feat" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Commit scope" }), {
      target: { value: "ui)" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Commit summary" }), {
      target: { value: "subject" },
    });

    expect(useUi.getState().commitMsg).toBe("feat(ui): subject");
  });

  it("closes an open popover on outside scroll (viewport-fixed anchor goes stale)", () => {
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: "Draft" }));
    expect(screen.getByRole("menu", { name: "Draft with agent" })).toBeInTheDocument();

    fireEvent.scroll(window);
    expect(screen.queryByRole("menu", { name: "Draft with agent" })).not.toBeInTheDocument();
  });

  it("keeps a popover open while scrolling inside its own list", () => {
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: "Draft" }));
    fireEvent.scroll(screen.getByRole("menu", { name: "Draft with agent" }));

    expect(screen.getByRole("menu", { name: "Draft with agent" })).toBeInTheDocument();
  });

  it("disables the chained push actions on a detached HEAD", async () => {
    useRepo.setState({
      summary: { path: "/repo", workdir: "/repo", headBranch: null, headOid: "abc", detached: true },
    });
    useUi.setState({ commitMsg: "fix: something" });
    renderComposer();

    await screen.findByRole("button", { name: /^Commit identity:/ });
    openCommitMenu();

    const pushItem = screen.getByRole("menuitem", { name: "Commit & push" });
    expect(pushItem).toBeDisabled();
    expect(pushItem).toHaveAttribute("title", "Check out a branch to push");
  });

  it("keeps a message edited while the commit was in flight", async () => {
    let resolveCommit: (ok: boolean) => void = () => {};
    const commitSelected = vi.fn(() => new Promise<boolean>((resolve) => { resolveCommit = resolve; }));
    useRepo.setState({ commitSelected });
    useUi.setState({ commitMsg: "fix: original" });
    renderComposer();

    fireEvent.click(await screen.findByRole("button", { name: "Commit 1 file → main" }));
    act(() => {
      useUi.getState().setCommitMsg("fix: edited meanwhile");
    });
    await act(async () => {
      resolveCommit(true);
    });

    expect(useUi.getState().commitMsg).toBe("fix: edited meanwhile");
  });

  it("keeps a same-text draft created by a reopened same-path repo session", async () => {
    const commitGate = deferred<boolean>();
    useRepo.setState({ commitSelected: vi.fn(() => commitGate.promise) });
    useUi.setState({ commitMsg: "fix: same text" });
    renderComposer();

    fireEvent.click(await screen.findByRole("button", { name: "Commit 1 file → main" }));
    beginPublishedRepoSession();
    useRepo.setState({
      summary: { path: "/other", workdir: "/other", headBranch: "main", headOid: "other", detached: false },
    });
    beginPublishedRepoSession();
    useRepo.setState({
      summary: { path: "/repo", workdir: "/repo", headBranch: "main", headOid: "new", detached: false },
    });
    useUi.getState().setCommitMsg("fix: same text");

    await act(async () => commitGate.resolve(true));

    expect(useUi.getState().commitMsg).toBe("fix: same text");
  });

  it("does not push after commit when the same path and branch were reopened", async () => {
    const commitGate = deferred<boolean>();
    const push = vi.fn(async () => {});
    useRepo.setState({
      commitSelected: vi.fn(() => commitGate.promise),
      push,
      branches: [localBranch()],
    });
    useUi.setState({ commitMsg: "fix: something" });
    renderComposer();
    await screen.findByRole("button", { name: /^Commit identity:/ });
    openCommitMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Commit & push" }));

    beginPublishedRepoSession();
    useRepo.setState({
      summary: { path: "/other", workdir: "/other", headBranch: "main", headOid: "other", detached: false },
    });
    beginPublishedRepoSession();
    useRepo.setState({
      summary: { path: "/repo", workdir: "/repo", headBranch: "main", headOid: "new", detached: false },
    });
    await act(async () => commitGate.resolve(true));

    expect(push).not.toHaveBeenCalled();
  });

  it("does not open a PR when a push settles into a reopened same checkout", async () => {
    const pushGate = deferred<void>();
    const push = vi.fn(() => pushGate.promise);
    useRepo.setState({ push, forge: githubForge, branches: [localBranch()] });
    useUi.setState({ commitMsg: "fix: something" });
    renderComposer();
    await screen.findByRole("button", { name: /^Commit identity:/ });
    openCommitMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Commit, push & open PR…" }));
    await waitFor(() => expect(push).toHaveBeenCalled());

    beginPublishedRepoSession();
    useRepo.setState({
      summary: { path: "/other", workdir: "/other", headBranch: "main", headOid: "other", detached: false },
    });
    beginPublishedRepoSession();
    useRepo.setState({
      summary: { path: "/repo", workdir: "/repo", headBranch: "main", headOid: "new", detached: false },
      branches: [localBranch()],
    });
    await act(async () => pushGate.resolve(undefined));

    expect(useUi.getState().createPrOpen).toBe(false);
  });

  it("hides the open-PR action for a repo without a PR forge", () => {
    useUi.setState({ commitMsg: "fix: something" });
    renderComposer();

    openCommitMenu();
    expect(screen.queryByRole("menuitem", { name: "Commit, push & open PR…" })).not.toBeInTheDocument();
  });

  it("shows the published-HEAD warning only after amend is selected", async () => {
    useRepo.setState({ graph: publishedHeadGraph() });
    renderComposer();

    const amendOption = screen.getByRole("checkbox", { name: /Amend previous commit/ });
    expect(amendOption).toBeEnabled();
    expect(useUi.getState().commitMsg).toBe("");
    expect(screen.queryByText(/abc1234 is already on a remote/)).not.toBeInTheDocument();

    fireEvent.click(amendOption);

    expect(useUi.getState().commitMsg).toBe("previous summary");
    expect(amendOption).toBeChecked();
    expect(screen.getByText(/abc1234 is already on a remote/)).toBeVisible();
    expect(amendOption.closest("label")).toHaveAttribute(
      "title",
      "abc1234 is already on a remote; force-push with lease after amending",
    );
    const amendButton = screen.getByRole("button", { name: "Amend last commit" });
    await waitFor(() => expect(amendButton).toBeEnabled());

    openCommitMenu();
    expect(screen.queryByRole("menuitem", { name: "Amend previous commit" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Amend & push" })).toBeDisabled();

    fireEvent.click(amendButton);
    expect(useRepo.getState().commitSelected).toHaveBeenCalledWith("previous summary", true);
  });

  it("uses the configured Commit with agent instruction from the commit menu", async () => {
    const sendToTerminal = vi.fn();
    useUi.setState({ sendToTerminal });
    useCommitAgentMessages.setState({
      messages: {
        ...DEFAULT_COMMIT_AGENT_MESSAGES,
        commitInstruction: "Commit the staged work using our team convention.",
      },
    });
    renderComposer();

    await screen.findByRole("button", { name: /^Commit identity:/ });
    openCommitMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /codex/ }));

    expect(sendToTerminal).toHaveBeenCalledWith(
      "Commit the staged work using our team convention.",
      "codex",
    );
  });

  it("keeps the composer visible and the terminal shut while an agent drafts", () => {
    const sendToTerminal = vi.fn();
    const acpPrompt = vi.fn(() => new Promise<string>(() => {}));
    useUi.setState({ sendToTerminal });
    useRepo.setState({ acpPrompt });
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: "Draft" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /codex/ }));

    expect(acpPrompt).toHaveBeenCalledWith(
      "codex-acp",
      "/repo",
      "",
      {},
      expect.any(String),
      expect.any(String),
    );
    expect(sendToTerminal).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Commit summary" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(/Starting the agent/);
    expect(useUi.getState().commitDraftAgent).toBe("codex");
  });

  it("sends an edited message as the draft improvement target", () => {
    const acpPrompt = vi.fn(() => new Promise<string>(() => {}));
    useUi.setState({ commitMsg: "fix: initial message" });
    useRepo.setState({ acpPrompt });
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: "Improve" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /codex/ }));

    expect(acpPrompt).toHaveBeenCalledWith(
      "codex-acp",
      "/repo",
      "",
      {},
      expect.stringContaining(
        'improve this existing conventional commit message: "fix: initial message"',
      ),
      expect.any(String),
    );
  });

  it("marks the remembered draft agent as the active menu choice", () => {
    useAcpAgents.setState({ agents: [agent(), agent({ id: "claude", name: "claude", command: "claude-acp" })] });
    useUi.setState({ commitDraftAgent: "codex" });
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: "Draft" }));
    // The active row carries a second svg (sparkle + check); others only the sparkle.
    expect(screen.getByRole("menuitem", { name: /codex/ }).querySelectorAll("svg")).toHaveLength(2);
    expect(screen.getByRole("menuitem", { name: /claude/ }).querySelectorAll("svg")).toHaveLength(1);
  });

  it("blocks commit actions for guarded staged changes", () => {
    useRepo.setState({
      changes: {
        staged: [
          {
            path: "deps/child",
            status: "M",
            add: 0,
            del: 0,
            binary: false,
            advanced: { kind: "submodule", message: "Submodule: modified files inside submodule" },
          },
        ],
        unstaged: [],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
    });
    useUi.setState({ commitMsg: "chore: update dependency" });
    renderComposer();

    expect(screen.getByRole("button", { name: "Commit 1 file → main" })).toBeDisabled();
    expect(
      screen.getByText(
        "Submodule: modified files inside submodule. Use the terminal for submodule updates.",
      ),
    ).toBeVisible();
  });

  it("shows one settings hint when no AI agents are configured", () => {
    useAcpAgents.setState({ agents: [] });
    useTerminalAgents.setState({ agents: [] });
    renderComposer();

    expect(screen.getAllByText("No in-app agent. Set an ACP adapter in Settings.")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Draft" })).not.toBeInTheDocument();
    openCommitMenu();
    expect(screen.queryByText("Commit with agent")).not.toBeInTheDocument();
  });

  it("offers a terminal-only agent for Commit with agent but not for Draft", () => {
    // The two surfaces need different things: Commit with agent hands work off
    // to a terminal, Draft needs an answer back through ACP.
    useAcpAgents.setState({ agents: [] });
    useTerminalAgents.setState({ agents: [tuiAgent({ id: "tui", name: "tui" })] });
    renderComposer();

    expect(screen.queryByRole("button", { name: "Draft" })).not.toBeInTheDocument();
    expect(screen.getByText("No in-app agent. Set an ACP adapter in Settings.")).toBeVisible();
    openCommitMenu();
    expect(screen.getByText("Commit with agent")).toBeVisible();
  });

  it("starts collapsed and restores the editor state across collapse cycles", () => {
    useUi.setState({ commitMsg: "fix: half-written" });
    render(<CommitComposer />);

    // Collapsed by default; the bar advertises the in-progress message.
    expect(screen.queryByRole("textbox", { name: "Commit summary" })).not.toBeInTheDocument();
    expect(screen.getByText("Continue message →")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Expand commit composer" }));
    expect(screen.getByRole("textbox", { name: "Commit summary" })).toHaveValue("half-written");

    fireEvent.click(screen.getByRole("button", { name: "Collapse commit composer" }));
    expect(screen.queryByRole("textbox", { name: "Commit summary" })).not.toBeInTheDocument();
  });
});
