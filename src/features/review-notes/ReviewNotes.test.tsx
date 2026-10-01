import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useUi } from "@/store/ui";
import { AgentMessageDialog } from "./ReviewNotes";

const note = {
  id: "work#a.ts#R1-R1",
  surface: "work",
  file: "a.ts",
  side: "R" as const,
  line: 1,
  fromRef: "R1",
  toRef: "R1",
  lineRef: "R1",
  code: "const a = 1;",
  body: "Rename this",
};

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  useTerminalAgents.setState({ agents: [], loadAgents: async () => {} });
  useUi.setState({
    agentMessageOpen: true,
    agentMessageSurfaces: ["work"],
    agentMessageBranch: "main",
    reviewNotes: [note],
  });
});

afterEach(() => useUi.setState({ agentMessageOpen: false, reviewNotes: [] }));

describe("AgentMessageDialog Copy", () => {
  it("keeps the dialog (and the edited message) when the clipboard write fails", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<AgentMessageDialog />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
    expect(writeText).toHaveBeenCalled();
    expect(useUi.getState().agentMessageOpen).toBe(true);
  });

  it("closes once the text is on the clipboard", async () => {
    writeText.mockResolvedValue();
    render(<AgentMessageDialog />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
    expect(useUi.getState().agentMessageOpen).toBe(false);
  });
});
