import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalAgent } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import {
  DEFAULT_COMMIT_AGENT_MESSAGES,
  useCommitAgentMessages,
} from "@/store/commitAgentMessages";
import { useRepo } from "@/store/repo";
import { useAcpAgents } from "@/store/acpAgents";
import { useUi } from "@/store/ui";
import { ChangeSummaryCard } from "./ChangeSummaryCard";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

const changes = {
  staged: [{ path: "src/a.ts", status: "M" as const, add: 2, del: 1, binary: false }],
  unstaged: [],
  conflicted: [],
  advanced: emptyAdvancedState,
};

beforeEach(() => {
  useRepo.setState({
    summary: {
      path: "/repo",
      workdir: "/repo",
      headBranch: "main",
      headOid: "abc",
      detached: false,
    },
  });
  useAcpAgents.setState({
    agents: [{ id: "codex", name: "codex", command: "codex-acp", model: "", config: {}, description: "", enabled: true, available: true }],
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
  useUi.setState({
    terminalView: "hidden",
    terminalViewByRepo: {},
    terminalExpanded: false,
  });
});

describe("ChangeSummaryCard", () => {
  it("keeps the request alive when a metadata-only watcher refresh republishes equivalent changes", async () => {
    let resolveSummary: (value: string) => void = () => {};
    const acpPrompt = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveSummary = resolve;
        }),
    );
    useRepo.setState({ acpPrompt });

    const { rerender } = render(<ChangeSummaryCard changes={changes} />);
    fireEvent.click(screen.getByRole("button", { name: "Describe changes with agent" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "codex" }));
    await waitFor(() => expect(acpPrompt).toHaveBeenCalledTimes(1));

    rerender(
      <ChangeSummaryCard
        changes={{ ...changes, staged: changes.staged.map((file) => ({ ...file })) }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/Starting the agent/);

    act(() => resolveSummary("Summary survived the Git metadata refresh."));
    expect(await screen.findByText("Summary survived the Git metadata refresh.")).toBeVisible();
  });

  it("renders the AI description as Markdown, with a Source fallback", async () => {
    const acpPrompt = vi.fn(async () =>
      ["## Summary", "", "- **Codex model selection**: prefers `configOptions`"].join("\n"),
    );
    useRepo.setState({ acpPrompt });

    render(<ChangeSummaryCard changes={changes} />);
    fireEvent.click(screen.getByRole("button", { name: "Describe changes with agent" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "codex" }));

    expect(await screen.findByRole("heading", { name: "Summary" })).toBeVisible();
    expect(screen.getByText("Codex model selection").tagName).toBe("STRONG");
    expect(screen.getByText("configOptions").tagName).toBe("CODE");
    expect(screen.queryByText(/\*\*Codex model selection\*\*/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByText(/\*\*Codex model selection\*\*/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("heading", { name: "Summary" })).toBeVisible();
  });

  it("asks the ACP agent directly, leaving the terminal untouched", async () => {
    const sendToTerminal = vi.fn();
    const acpPrompt = vi.fn(
      async (
        _agentCommand: string,
        _repoPath: string,
        _model: string,
        _config: Record<string, string>,
        _prompt: string,
        _runId: string,
      ) => "Adds an ACP client and routes Describe through it.",
    );
    useAcpAgents.setState({
      agents: [
        { id: "claude", name: "claude", command: "npx -y @agentclientprotocol/claude-agent-acp", model: "", config: {}, description: "", enabled: true, available: true },
      ],
    });
    useUi.setState({ sendToTerminal, terminalView: "open" });
    useRepo.setState({ acpPrompt });

    render(<ChangeSummaryCard changes={changes} />);
    fireEvent.click(screen.getByRole("button", { name: "Describe changes with agent" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "claude" }));

    expect(
      await screen.findByText("Adds an ACP client and routes Describe through it."),
    ).toBeVisible();
    expect(acpPrompt).toHaveBeenCalledWith(
      "npx -y @agentclientprotocol/claude-agent-acp",
      "/repo",
      "",
      {},
      expect.stringContaining("not a code review"),
      expect.any(String),
    );
    // The prompt is the task and nothing else — no delivery contract — and an
    // open terminal is left exactly as the user had it.
    expect(acpPrompt.mock.calls[0][3]).not.toContain("git rev-parse --git-path");
    expect(sendToTerminal).not.toHaveBeenCalled();
    expect(useUi.getState().terminalView).toBe("open");
  });

  it("shows the pinned model and offers an agent whose terminal command is missing", async () => {
    // `available` probes the *terminal* command on PATH, which says nothing
    // about the ACP adapter. Gating on it disabled perfectly good in-app agents.
    const acpPrompt = vi.fn(async () => "Summary.");
    useAcpAgents.setState({
      agents: [
        { id: "codex", name: "codex", command: "npx -y @agentclientprotocol/codex-acp", model: "gpt-5.6-sol[low]", config: {}, description: "", enabled: true, available: false },
      ],
    });
    useRepo.setState({ acpPrompt });

    render(<ChangeSummaryCard changes={changes} />);
    fireEvent.click(screen.getByRole("button", { name: "Describe changes with agent" }));

    // The model is what actually runs, so it is named next to the agent.
    expect(screen.getByText("gpt-5.6-sol[low]")).toBeVisible();

    const item = screen.getByRole("menuitem", { name: /codex/ });
    expect(item).toBeEnabled();
    fireEvent.click(item);
    await waitFor(() => expect(acpPrompt).toHaveBeenCalledTimes(1));
  });

  it("switches the agent's model from the menu and saves it", async () => {
    // Switching models used to mean Settings → expand a row → Connect → a
    // dropdown → Save. Doing it where the agent is picked is the whole point.
    const agent = { id: "codex", name: "codex", command: "codex-acp", model: "", config: {}, description: "", enabled: true, available: true };
    const saveAgents = vi.fn(async (_next: TerminalAgent[]) => {});
    useAcpAgents.setState({
      agents: [agent],
      saveAgents,
      acpStatus: {
        "codex-acp": {
          state: "ok",
          probe: {
            agentName: "Codex",
            agentVersion: "1.1.14",
            currentModelId: "gpt-5.6-luna[medium]",
            models: [
              { id: "gpt-5.6-sol[low]", name: "GPT-5.6-Sol (low)", description: "Fast" },
              { id: "gpt-5.6-luna[high]", name: "GPT-5.6-Luna (high)", description: "Deep" },
            ],
            configOptions: [],
          },
        },
      },
    });
    useRepo.setState({ acpPrompt: vi.fn(async () => "Summary.") });

    render(<ChangeSummaryCard changes={changes} />);
    fireEvent.click(screen.getByRole("button", { name: "Describe changes with agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose a model for codex" }));
    fireEvent.click(screen.getByRole("button", { name: /GPT-5.6-Luna \(high\)/ }));

    await waitFor(() => expect(saveAgents).toHaveBeenCalledTimes(1));
    // Persisted straight through — no draft, no Save button.
    expect(saveAgents.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: "codex", model: "gpt-5.6-luna[high]" }),
    ]);
  });

  it("surfaces an ACP failure instead of leaving the spinner running", async () => {
    useAcpAgents.setState({
      agents: [
        { id: "claude", name: "claude", command: "missing-adapter", model: "", config: {}, description: "", enabled: true, available: true },
      ],
    });
    useRepo.setState({
      acpPrompt: vi.fn(async () => {
        throw new Error("`missing-adapter` was not found.");
      }),
    });

    render(<ChangeSummaryCard changes={changes} />);
    fireEvent.click(screen.getByRole("button", { name: "Describe changes with agent" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "claude" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("was not found");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("hides when no ACP-capable agent is configured", async () => {
    // A terminal-only agent can launch a CLI but has no channel to answer on,
    // so it must not be offered here.
    useAcpAgents.setState({
      agents: [
        { id: "codex", name: "codex", command: "", model: "", config: {}, description: "", enabled: true, available: true },
      ],
    });
    const { container } = render(<ChangeSummaryCard changes={changes} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
