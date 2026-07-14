import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
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
});

describe("ChangeSummaryCard", () => {
  it("hands the review to an agent and renders the returned inline summary", async () => {
    const sendToTerminal = vi.fn();
    const takeAgentChangeSummary = vi.fn(async () => "Updates staging review behavior and its tests.");
    useUi.setState({ sendToTerminal });
    useRepo.setState({ takeAgentChangeSummary });

    render(<ChangeSummaryCard changes={changes} />);
    fireEvent.click(screen.getByRole("button", { name: "Summarize changes" }));

    expect(sendToTerminal).toHaveBeenCalledWith(
      expect.stringContaining("Do not modify files and do not commit"),
      "codex",
    );
    expect(screen.getByRole("status")).toHaveTextContent("reviewing changes");
    expect(await screen.findByText("Updates staging review behavior and its tests.", {}, { timeout: 2_000 })).toBeVisible();
    expect(takeAgentChangeSummary).toHaveBeenCalledTimes(1);
  });

  it("hides when no enabled agent is available", async () => {
    useTerminalAgents.setState({ agents: [] });
    const { container } = render(<ChangeSummaryCard changes={changes} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
