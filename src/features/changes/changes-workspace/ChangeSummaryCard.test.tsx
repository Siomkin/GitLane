import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import {
  DEFAULT_COMMIT_AGENT_MESSAGES,
  useCommitAgentMessages,
} from "@/store/commitAgentMessages";
import { useRepo } from "@/store/repo";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useUi } from "@/store/ui";
import { ChangeSummaryCard } from "./ChangeSummaryCard";

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
  useTerminalAgents.setState({
    agents: [{ id: "codex", name: "codex", command: "codex", description: "", enabled: true, available: true }],
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
  it("explains the action and renders the returned inline description", async () => {
    const sendToTerminal = vi.fn();
    const takeAgentChangeSummary = vi.fn(async () => "Updates staging review behavior and its tests.");
    useUi.setState({ sendToTerminal, terminalView: "open", terminalExpanded: true });
    useRepo.setState({ takeAgentChangeSummary });

    render(<ChangeSummaryCard changes={changes} />);
    expect(screen.getByText("Explain what these changes do")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Describe changes with agent" }));
    expect(screen.getByRole("menu", { name: "Describe with" })).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "codex" }));

    expect(sendToTerminal).toHaveBeenCalledWith(
      expect.stringMatching(
        /as much detail as needed[\s\S]*Do not create, edit, stage, delete, or otherwise alter any tracked or untracked working-tree file/,
      ),
      "codex",
    );
    const prompt = sendToTerminal.mock.calls[0][0];
    // Delivery must be pinned to the Git-metadata mailbox — never a loose
    // worktree file that would dirty the tree and cancel the poll (review #1).
    expect(prompt).toContain("only authorized filesystem writes");
    // One-shot mailbox contract: don't re-read after the rename, end the turn
    // (review #2).
    expect(prompt).toContain("do not inspect, read, list, or verify it afterward");
    expect(prompt).toContain("end the turn immediately");
    expect(prompt).not.toContain("two to four sentences");
    expect(prompt).not.toContain("200 characters");
    expect(screen.getByRole("status")).toHaveTextContent("describing these changes");
    expect(await screen.findByText("Updates staging review behavior and its tests.", {}, { timeout: 2_000 })).toBeVisible();
    expect(takeAgentChangeSummary).toHaveBeenCalledTimes(1);
    expect(useUi.getState().terminalView).toBe("collapsed");
    expect(useUi.getState().terminalExpanded).toBe(false);
  });

  it("keeps polling when a metadata-only watcher refresh republishes equivalent changes", async () => {
    let resolveSummary: (value: string) => void = () => {};
    const takeAgentChangeSummary = vi.fn(
      () => new Promise<string>((resolve) => {
        resolveSummary = resolve;
      }),
    );
    useUi.setState({ sendToTerminal: vi.fn() });
    useRepo.setState({ takeAgentChangeSummary });

    const { rerender } = render(<ChangeSummaryCard changes={changes} />);
    fireEvent.click(screen.getByRole("button", { name: "Describe changes with agent" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "codex" }));
    await waitFor(() => expect(takeAgentChangeSummary).toHaveBeenCalledTimes(1));

    rerender(
      <ChangeSummaryCard
        changes={{ ...changes, staged: changes.staged.map((file) => ({ ...file })) }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("describing these changes");

    act(() => resolveSummary("Summary survived the Git metadata refresh."));
    expect(await screen.findByText("Summary survived the Git metadata refresh.")).toBeVisible();
  });

  it("keeps polling when only advanced repo state (LFS/submodule) refreshes", async () => {
    let resolveSummary: (value: string) => void = () => {};
    const takeAgentChangeSummary = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveSummary = resolve;
        }),
    );
    useUi.setState({ sendToTerminal: vi.fn() });
    useRepo.setState({ takeAgentChangeSummary });

    const { rerender } = render(<ChangeSummaryCard changes={changes} />);
    fireEvent.click(screen.getByRole("button", { name: "Describe changes with agent" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "codex" }));
    await waitFor(() => expect(takeAgentChangeSummary).toHaveBeenCalledTimes(1));

    // A watcher refresh that only changes advanced state — the file buckets are
    // untouched — must not change the context key and cancel the in-flight poll.
    rerender(
      <ChangeSummaryCard
        changes={{
          ...changes,
          advanced: {
            ...emptyAdvancedState,
            lfs: { ...emptyAdvancedState.lfs, detected: true },
          },
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("describing these changes");

    act(() => resolveSummary("Summary survived the advanced-state refresh."));
    expect(
      await screen.findByText("Summary survived the advanced-state refresh."),
    ).toBeVisible();
  });

  it("uses the change-description instruction configured in Settings", () => {
    const sendToTerminal = vi.fn();
    useUi.setState({ sendToTerminal });
    useRepo.setState({ takeAgentChangeSummary: vi.fn(async () => null) });
    useCommitAgentMessages.setState({
      messages: {
        ...DEFAULT_COMMIT_AGENT_MESSAGES,
        descriptionInstruction: "Explain the product impact in exactly three sentences.",
      },
    });

    render(<ChangeSummaryCard changes={changes} />);
    fireEvent.click(screen.getByRole("button", { name: "Describe changes with agent" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "codex" }));

    expect(sendToTerminal).toHaveBeenCalledWith(
      expect.stringContaining("Explain the product impact in exactly three sentences."),
      "codex",
    );
  });

  it("hides when no enabled agent is available", async () => {
    useTerminalAgents.setState({ agents: [] });
    const { container } = render(<ChangeSummaryCard changes={changes} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
