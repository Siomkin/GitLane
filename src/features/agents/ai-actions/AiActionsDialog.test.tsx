import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AcpAgent } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { useAcpAgents } from "@/store/acpAgents";
import { DEFAULT_COMMIT_AGENT_MESSAGES, useCommitAgentMessages } from "@/store/commitAgentMessages";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { acpAgent } from "@/test/agents";
import { AiActionScopeKind } from "./aiActions";
import { AiActionsDialog } from "./AiActionsDialog";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const AGENT = acpAgent("Claude Code");

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  useCommitAgentMessages.setState({
    messages: DEFAULT_COMMIT_AGENT_MESSAGES,
    loading: false,
    error: null,
    loadMessages: vi.fn(async () => {}),
  });
  useUi.setState({
    aiActions: { kind: AiActionScopeKind.Commits, commits: ["abcdef0"] },
    settingsOpen: false,
    settingsTab: "general",
  });
  useAcpAgents.setState({
    agents: [AGENT],
    loading: false,
    error: null,
    loadAgents: vi.fn(async () => {}),
  });
  useRepo.setState({
    summary: { path: "/repo", workdir: "/repo", headBranch: "feature/GL-12-x", headOid: "abcdef0", detached: false },
    graph: null,
    commitFiles: [{ path: "a.ts", status: "M", add: 4, del: 1, binary: false }],
    selectedCommit: "abcdef0",
    selectedCommits: ["abcdef0"],
    selectionDiff: null,
    changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
    acpPrompt: vi.fn(
      async (
        _command: string,
        _repoPath: string,
        _model: string,
        _config: Record<string, string>,
        _prompt: string,
        _runId: string,
      ) => "Virtualize the commit graph.",
    ),
    acpCancel: vi.fn(async (_runId: string) => true),
  });
});

describe("AiActionsDialog", () => {
  it("renders nothing while closed", () => {
    useUi.setState({ aiActions: null });
    const { container } = render(<AiActionsDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the idle surface for the selected commit", () => {
    render(<AiActionsDialog />);
    expect(screen.getByRole("dialog", { name: "AI actions" })).toBeInTheDocument();
    expect(screen.getByText("Commit abcdef0")).toBeInTheDocument();
    expect(screen.getByText("Implementation comment — not generated yet")).toBeInTheDocument();
    expect(screen.getByText("GL-12")).toBeInTheDocument();
    expect(screen.getByText(/from branch/)).toBeInTheDocument();
  });

  it("starts on short description when the request preselects it", () => {
    useUi.setState({ aiActions: { kind: AiActionScopeKind.Commits, commits: ["abcdef0"], action: "short" } });
    render(<AiActionsDialog />);
    expect(screen.getByText("Short description — not generated yet")).toBeInTheDocument();
    expect(screen.queryByText(/Implementation comment — not generated/)).not.toBeInTheDocument();
  });

  it("falls back to the next enabled command when short is disabled", () => {
    useCommitAgentMessages.setState({
      messages: {
        ...DEFAULT_COMMIT_AGENT_MESSAGES,
        aiActions: DEFAULT_COMMIT_AGENT_MESSAGES.aiActions.map((row) =>
          row.id === "short" ? { ...row, enabled: false } : row,
        ),
      },
    });
    useUi.setState({ aiActions: { kind: AiActionScopeKind.Commits, commits: ["abcdef0"], action: "short" } });
    render(<AiActionsDialog />);
    expect(screen.getByText("Full description — not generated yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Full description$/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Full description$/ }));
    expect(screen.queryByRole("button", { name: /^Short description$/ })).not.toBeInTheDocument();
  });

  it("runs the selected action through ACP and shows the result", async () => {
    const acpPrompt = vi.fn(
      async (
        _command: string,
        _repoPath: string,
        _model: string,
        _config: Record<string, string>,
        _prompt: string,
        _runId: string,
      ) => "Virtualize the commit graph.",
    );
    useRepo.setState({ acpPrompt });
    render(<AiActionsDialog />);
    fireEvent.click(screen.getByRole("button", { name: /Run implementation comment/i }));
    await waitFor(() => expect(screen.getByText("Virtualize the commit graph.")).toBeInTheDocument());
    expect(acpPrompt).toHaveBeenCalledTimes(1);
    const prompt = acpPrompt.mock.calls[0][4];
    expect(prompt).toContain("git show abcdef0");
    expect(prompt).toContain("GL-12");
  });

  it("uses the available width for formatted, raw, and edited results", async () => {
    render(<AiActionsDialog />);
    fireEvent.click(screen.getByRole("button", { name: /Run implementation comment/i }));

    const formatted = (await screen.findByText("Virtualize the commit graph.")).parentElement;
    expect(formatted).toHaveClass("w-full");
    expect(formatted).not.toHaveClass("max-w-[74ch]");

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    const raw = screen.getByText("Virtualize the commit graph.");
    expect(raw).toHaveClass("w-full");
    expect(raw).not.toHaveClass("max-w-[80ch]");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByDisplayValue("Virtualize the commit graph.");
    expect(editor).toHaveClass("w-full");
    expect(editor).not.toHaveClass("max-w-[76ch]");
  });

  it("hides the stored prompt until shown, and Edit in Settings opens Prompts", () => {
    render(<AiActionsDialog />);
    const instruction = DEFAULT_COMMIT_AGENT_MESSAGES.aiActions.find((row) => row.id === "impl")!
      .instruction;
    expect(screen.queryByText(instruction)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show prompt" }));
    expect(screen.getByText(instruction)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit in Settings" }));
    expect(useUi.getState().settingsOpen).toBe(true);
    expect(useUi.getState().settingsTab).toBe("prompts");
    // Settings takes over: two stacked modals would both hold a focus trap and
    // leave this dialog's Run chord live behind the one the user is looking at.
    expect(useUi.getState().aiActions).toBeNull();
  });

  it("leaves the Run chord to the editor while the result is being edited", async () => {
    render(<AiActionsDialog />);
    fireEvent.click(screen.getByRole("button", { name: /Run implementation comment/i }));
    await screen.findByText("Virtualize the commit graph.");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    fireEvent.keyDown(document, { key: "Enter", code: "Enter", metaKey: true, ctrlKey: true });

    // A run clears `out`, so firing here would throw away the user's edit.
    expect(screen.getByDisplayValue("Virtualize the commit graph.")).toBeInTheDocument();
  });

  it("hides the prompt preview for Custom, which has no stored instruction", () => {
    render(<AiActionsDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Implementation comment" }));
    fireEvent.click(screen.getByRole("button", { name: "Custom prompt" }));
    expect(screen.queryByRole("button", { name: "Show prompt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit in Settings" })).not.toBeInTheDocument();
  });

  it("reuses the commit agent menu so model and effort can be picked here", async () => {
    const saveAgents = vi.fn(async (_next: AcpAgent[]) => {});
    useAcpAgents.setState({
      agents: [AGENT],
      saveAgents,
      acpStatus: {
        [AGENT.command]: {
          state: "ok",
          probe: {
            agentName: "Claude Code",
            agentVersion: "1",
            currentModelId: "sonnet",
            models: [
              { id: "sonnet", name: "Sonnet", description: "" },
              { id: "opus", name: "Opus", description: "" },
            ],
            configOptions: [
              {
                id: "effort",
                name: "Effort",
                category: "thought_level",
                currentValue: "medium",
                options: [
                  { id: "low", name: "Low", description: "" },
                  { id: "high", name: "High", description: "" },
                ],
              },
            ],
          },
        },
      },
    });
    render(<AiActionsDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Choose agent" }));
    expect(screen.getByRole("menuitem", { name: "Claude Code" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose a model for Claude Code" }));
    fireEvent.click(screen.getByRole("button", { name: "Opus" }));
    await waitFor(() => expect(saveAgents).toHaveBeenCalledTimes(1));
    expect(saveAgents.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: AGENT.id, model: "opus" }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Choose a model for Claude Code" }));
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    await waitFor(() => expect(saveAgents).toHaveBeenCalledTimes(2));
    expect(saveAgents.mock.calls[1][0]).toEqual([
      expect.objectContaining({ id: AGENT.id, config: { effort: "high" } }),
    ]);
  });

  it("copies the result", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const acpPrompt = vi.fn(
      async (
        _command: string,
        _repoPath: string,
        _model: string,
        _config: Record<string, string>,
        _prompt: string,
        _runId: string,
      ) => "One sentence.",
    );
    useRepo.setState({ acpPrompt });
    render(<AiActionsDialog />);
    fireEvent.click(screen.getByRole("button", { name: /Run implementation comment/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument());
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      expect(writeText).toHaveBeenCalledWith("One sentence.");
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1_500);
      });
      expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
