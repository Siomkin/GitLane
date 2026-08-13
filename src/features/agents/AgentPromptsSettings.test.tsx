import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  DEFAULT_COMMIT_AGENT_MESSAGES,
  useCommitAgentMessages,
} from "@/store/commitAgentMessages";
import { useUi } from "@/store/ui";
import { AgentPromptsSettings } from "./AgentPromptsSettings";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string) => {
    if (command === "commit_agent_messages_get") {
      return Promise.resolve(DEFAULT_COMMIT_AGENT_MESSAGES);
    }
    if (command === "commit_agent_messages_set") return Promise.resolve();
    return Promise.resolve();
  });
  useCommitAgentMessages.setState({
    messages: DEFAULT_COMMIT_AGENT_MESSAGES,
    loading: false,
    error: null,
    loadMessages: vi.fn(async () => {}),
  });
  useUi.setState({ confirm: null });
});

describe("AgentPromptsSettings", () => {
  it("saves an expanded commit prompt and command with Save, not a page-level button", async () => {
    render(<AgentPromptsSettings />);
    expect(screen.queryByRole("button", { name: "Save prompts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Commit message/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Commit message$/ }));
    expect(screen.getByRole("button", { name: "Save Commit message" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt for Commit message" }), {
      target: { value: "Write a conventional commit message from the staged diff." },
    });
    expect(screen.getByRole("button", { name: "Save Commit message" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save Commit message" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_agent_messages_set", {
        messages: expect.objectContaining({
          draftInstruction: "Write a conventional commit message from the staged diff.",
          commitInstruction: "Write a conventional commit message from the staged diff.",
        }),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Short description$/ }));
    expect(screen.getByRole("button", { name: "Save Short description" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt for Short description" }), {
      target: { value: "One sentence, nothing else." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Short description" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_agent_messages_set", {
        messages: expect.objectContaining({
          aiActions: expect.arrayContaining([
            expect.objectContaining({ id: "short", instruction: "One sentence, nothing else." }),
          ]),
        }),
      }),
    );
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("acp_agents_set", expect.anything());
  });

  it("saves only the row whose Save was clicked, not every open editor", async () => {
    // Both rows can be expanded at once — `startEdit` does not collapse a
    // sibling. Saving one used to persist the whole draft, writing a half-typed
    // commit prompt to disk where Cancel could no longer restore it.
    render(<AgentPromptsSettings />);

    fireEvent.click(screen.getByRole("button", { name: /^Commit message$/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt for Commit message" }), {
      target: { value: "HALF-TYPED, never saved." },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Short description$/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt for Short description" }), {
      target: { value: "One sentence, nothing else." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Short description" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("commit_agent_messages_set", {
      messages: expect.objectContaining({
        aiActions: expect.arrayContaining([
          expect.objectContaining({ id: "short", instruction: "One sentence, nothing else." }),
        ]),
      }),
    }));

    const written = invokeMock.mock.calls
      .filter(([command]) => command === "commit_agent_messages_set")
      .map(([, args]) => (args as { messages: { draftInstruction: string } }).messages);
    for (const messages of written) {
      expect(messages.draftInstruction).not.toContain("HALF-TYPED");
      expect(messages.draftInstruction).toBe(DEFAULT_COMMIT_AGENT_MESSAGES.draftInstruction);
    }
    // The untouched row is still open with its unsaved text intact.
    expect(screen.getByRole("textbox", { name: "Prompt for Commit message" })).toHaveValue(
      "HALF-TYPED, never saved.",
    );
  });

  it("keeps the editor open when the write is rejected", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "commit_agent_messages_get") {
        return Promise.resolve(DEFAULT_COMMIT_AGENT_MESSAGES);
      }
      if (command === "commit_agent_messages_set") return Promise.reject(new Error("disk full"));
      return Promise.resolve();
    });
    render(<AgentPromptsSettings />);

    fireEvent.click(screen.getByRole("button", { name: /^Short description$/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt for Short description" }), {
      target: { value: "One sentence, nothing else." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Short description" }));

    // Collapsing here would present the unsaved text as saved.
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("commit_agent_messages_set", expect.anything()));
    expect(await screen.findByRole("textbox", { name: "Prompt for Short description" })).toHaveValue(
      "One sentence, nothing else.",
    );
  });

  it("cancels an in-progress edit without writing", async () => {
    render(<AgentPromptsSettings />);
    fireEvent.click(screen.getByRole("button", { name: /^Commit message$/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt for Commit message" }), {
      target: { value: "Throw this away." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel Commit message" }));
    expect(screen.queryByRole("textbox", { name: "Prompt for Commit message" })).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("commit_agent_messages_set", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: /^Commit message$/ }));
    expect(screen.getByRole("textbox", { name: "Prompt for Commit message" })).toHaveValue(
      DEFAULT_COMMIT_AGENT_MESSAGES.draftInstruction,
    );
  });

  it("saves a builtin toggle immediately", async () => {
    render(<AgentPromptsSettings />);
    fireEvent.click(screen.getByRole("switch", { name: "Disable Short description" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_agent_messages_set", {
        messages: expect.objectContaining({
          aiActions: expect.arrayContaining([
            expect.objectContaining({ id: "short", enabled: false }),
          ]),
        }),
      }),
    );
  });

  it("asks before resetting, then only fills the editor until Save", () => {
    useCommitAgentMessages.setState({
      messages: {
        ...DEFAULT_COMMIT_AGENT_MESSAGES,
        draftInstruction: "Custom commit prompt.",
        commitInstruction: "Custom commit prompt.",
      },
    });
    render(<AgentPromptsSettings />);
    fireEvent.click(screen.getByRole("button", { name: /^Commit message$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reset Commit message" }));
    expect(useUi.getState().confirm?.title).toBe("Reset to default?");
    act(() => {
      useUi.getState().confirm?.onConfirm();
    });
    expect(screen.getByRole("textbox", { name: "Prompt for Commit message" })).toHaveValue(
      DEFAULT_COMMIT_AGENT_MESSAGES.draftInstruction,
    );
    expect(invokeMock).not.toHaveBeenCalledWith("commit_agent_messages_set", expect.anything());
    expect(screen.getByRole("button", { name: "Save Commit message" })).toBeEnabled();
  });

  it("adds a custom command and can hide a builtin from the picker", async () => {
    render(<AgentPromptsSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Add command" }));
    expect(screen.getByRole("textbox", { name: "Command title" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Disable Short description" }));
    expect(screen.getByRole("switch", { name: "Enable Short description" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Short description" })).not.toBeInTheDocument();
  });
});
