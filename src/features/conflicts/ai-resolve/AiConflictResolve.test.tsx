import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAcpAgents } from "@/store/acpAgents";
import { acpAgent } from "@/test/agents";
import { AiConflictResolve } from "./AiConflictResolve";
import type { AiResolveRuns, AiRun } from "./useAiResolveRuns";

const run = (over: Partial<AiRun> = {}): AiRun => ({
  runId: null,
  startedAt: null,
  queued: false,
  proposed: false,
  agentName: "codex",
  error: null,
  ...over,
});

const runsProp = (over: Partial<AiResolveRuns> = {}): AiResolveRuns => ({
  runs: {},
  start: vi.fn(),
  clear: vi.fn(),
  busy: false,
  ...over,
});

const renderRow = (props: Partial<Parameters<typeof AiConflictResolve>[0]> = {}) => {
  const onDiscardProposal = vi.fn();
  const result = render(
    <AiConflictResolve
      path="a.ts"
      allPaths={["a.ts"]}
      runs={runsProp()}
      onDiscardProposal={onDiscardProposal}
      {...props}
    />,
  );
  return { ...result, onDiscardProposal };
};

beforeEach(() => {
  useAcpAgents.setState({ agents: [acpAgent("codex")] });
});

describe("AiConflictResolve", () => {
  it("keeps each file's note separate", async () => {
    const user = userEvent.setup();
    renderRow();

    await user.type(screen.getByLabelText("Note for the agent"), "keep ours");
    expect(screen.getByLabelText("Note for the agent")).toHaveValue("keep ours");
  });

  it("hides itself when no agent is configured", () => {
    useAcpAgents.setState({ agents: [] });
    const { container } = renderRow();
    expect(container).toBeEmptyDOMElement();
  });

  it("does not show a review card — Output is the review", () => {
    renderRow({ runs: runsProp({ runs: { "a.ts": run({ error: "couldn't map" }) } }) });

    expect(screen.queryByLabelText("Proposed resolution")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply/i })).not.toBeInTheDocument();
  });

  it("points at Output for the review, and stages through the editor's own footer", () => {
    renderRow({ runs: runsProp({ runs: { "a.ts": run({ proposed: true }) } }) });

    expect(screen.getByRole("status")).toHaveTextContent("review it in Output");
    // Staging has one button — the editor footer's "Mark resolved & stage".
    expect(screen.queryByRole("button", { name: /stage/i })).not.toBeInTheDocument();
  });

  it("discards a proposal through the workspace, so the editor is reset too", async () => {
    const user = userEvent.setup();
    const props = runsProp({ runs: { "a.ts": run({ proposed: true }) } });
    const { onDiscardProposal } = renderRow({ runs: props });

    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscardProposal).toHaveBeenCalledWith("a.ts");
    expect(props.clear).not.toHaveBeenCalled();
  });

  it("says nothing about other files — a sweep resolves several at once", () => {
    renderRow({
      runs: runsProp({
        runs: {
          "a.ts": run({ queued: true }),
          "b.ts": run({ startedAt: 1, runId: "r" }),
          "c.ts": run({ proposed: true }),
        },
      }),
    });

    expect(screen.getByRole("status")).toHaveTextContent("Queued for codex…");
    for (const other of ["b.ts", "c.ts"]) {
      expect(screen.queryByText(new RegExp(other))).not.toBeInTheDocument();
    }
  });

  it("still clears a failed run directly", async () => {
    const user = userEvent.setup();
    const props = runsProp({ runs: { "a.ts": run({ error: "boom" }) } });
    const { onDiscardProposal } = renderRow({ runs: props });

    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(props.clear).toHaveBeenCalledWith("a.ts");
    expect(onDiscardProposal).not.toHaveBeenCalled();
  });
});
