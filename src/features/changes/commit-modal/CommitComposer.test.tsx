import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileChange, TerminalAgent } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { useAccounts } from "@/store/accounts";
import {
  DEFAULT_COMMIT_AGENT_MESSAGES,
  useCommitAgentMessages,
} from "@/store/commitAgentMessages";
import { useIdentities } from "@/store/identities";
import { useRepo } from "@/store/repo";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useUi } from "@/store/ui";
import { CommitComposer } from "./CommitComposer";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const staged = (path: string): FileChange => ({
  path,
  status: "M",
  add: 12,
  del: 3,
  binary: false,
});

const agent = (over: Partial<TerminalAgent> = {}): TerminalAgent => ({
  id: "codex",
  name: "codex",
  command: "codex",
  description: "",
  enabled: true,
  available: true,
  ...over,
});

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
    changes: {
      staged: [staged("src/feature.ts")],
      unstaged: [],
      conflicted: [],
      advanced: emptyAdvancedState,
    },
    commitSelected: vi.fn(async () => true),
  });
  useUi.setState({
    commitMsg: "",
    agentCommitDraft: null,
    sendToTerminal: vi.fn(),
  });
  useTerminalAgents.setState({
    agents: [agent()],
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
  it("renders inline without modal chrome and shows the effective identity", async () => {
    render(<CommitComposer />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Commit message" })).toBeVisible();
    expect(
      await screen.findByRole("button", {
        name: "Commit identity: Alex Global · alex@example.dev",
      }),
    ).toBeVisible();
  });

  it("commits the staged set and clears the message only after success", async () => {
    const commitSelected = vi.fn(async () => true);
    useRepo.setState({ commitSelected });
    useUi.setState({ commitMsg: "feat(changes): move commit controls inline" });
    render(<CommitComposer />);

    fireEvent.click(await screen.findByRole("button", { name: "Commit" }));

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
    render(<CommitComposer />);

    fireEvent.click(await screen.findByRole("button", { name: "Commit" }));

    expect(commitSelected).toHaveBeenCalled();
    expect(useUi.getState().commitMsg).toBe("fix: keep this message");
  });

  it("uses the configured Commit with agent instruction", async () => {
    const sendToTerminal = vi.fn();
    useUi.setState({ sendToTerminal });
    useCommitAgentMessages.setState({
      messages: {
        ...DEFAULT_COMMIT_AGENT_MESSAGES,
        commitInstruction: "Commit the staged work using our team convention.",
      },
    });
    render(<CommitComposer />);

    await screen.findByRole("button", { name: /^Commit identity:/ });
    fireEvent.click(screen.getByRole("button", { name: "Commit with agent" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /codex/ }));

    expect(sendToTerminal).toHaveBeenCalledWith(
      "Commit the staged work using our team convention.",
      "codex",
    );
  });

  it("keeps the composer visible while an agent drafts through the one-shot mailbox", () => {
    const sendToTerminal = vi.fn();
    useUi.setState({ sendToTerminal });
    render(<CommitComposer />);

    fireEvent.click(screen.getByRole("button", { name: "Draft with agent" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /codex/ }));

    const instruction = sendToTerminal.mock.calls[0]?.[0] as string;
    expect(instruction).toContain(
      "Do not create, edit, stage, delete, or otherwise alter any tracked or untracked working-tree file",
    );
    expect(instruction).toContain("Using shell file commands, not apply_patch");
    expect(instruction).toContain("end the turn immediately and run no more tools or commands");
    expect(screen.getByRole("textbox", { name: "Commit message" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("codex is drafting");
  });

  it("sends an edited message as the draft improvement target", () => {
    const sendToTerminal = vi.fn();
    useUi.setState({ sendToTerminal, commitMsg: "fix: initial message" });
    render(<CommitComposer />);

    fireEvent.click(screen.getByRole("button", { name: "Improve with agent" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /codex/ }));

    expect(sendToTerminal).toHaveBeenCalledWith(
      expect.stringContaining(
        'improve this existing conventional commit message: "fix: initial message"',
      ),
      "codex",
    );
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
    render(<CommitComposer />);

    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
    expect(
      screen.getByText(
        "Submodule: modified files inside submodule. Use the terminal for submodule updates.",
      ),
    ).toBeVisible();
  });

  it("shows one settings hint when no agents are enabled", () => {
    useTerminalAgents.setState({ agents: [] });
    render(<CommitComposer />);

    expect(screen.getAllByText("No enabled agents. Add one in Settings.")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Commit with agent" })).not.toBeInTheDocument();
  });
});
