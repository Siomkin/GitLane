import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { AcpAdapter, AcpAgent } from "@/lib/api";
import {
  DEFAULT_COMMIT_AGENT_MESSAGES,
  useCommitAgentMessages,
} from "@/store/commitAgentMessages";
import { useAcpAgents } from "@/store/acpAgents";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { AiAgentsSettings } from "./AiAgentsSettings";

const agent = (over: Partial<AcpAgent> = {}): AcpAgent => ({
  id: "claude",
  name: "Claude Code",
  command: "npx -y @agentclientprotocol/claude-agent-acp",
  model: "",
  config: {},
  description: "",
  enabled: true,
  available: true,
  ...over,
});

const adapter = (over: Partial<AcpAdapter> = {}): AcpAdapter => ({
  id: "cursor",
  name: "Cursor",
  command: "cursor-agent acp",
  install: "",
  docs: "https://cursor.com/downloads",
  requires: "The `cursor-agent` CLI, signed in.",
  available: true,
  ...over,
});

function stubBackend(agents: AcpAgent[] = [agent()], adapters: AcpAdapter[] = [adapter()]) {
  invokeMock.mockImplementation((command: string) => {
    if (command === "acp_agents_get") return Promise.resolve(agents);
    if (command === "acp_agents_set") return Promise.resolve();
    if (command === "acp_agents_reset") return Promise.resolve(agents);
    if (command === "acp_adapters") return Promise.resolve(adapters);
    if (command === "commit_agent_messages_get")
      return Promise.resolve(DEFAULT_COMMIT_AGENT_MESSAGES);
    if (command === "commit_agent_messages_set") return Promise.resolve();
    return Promise.resolve();
  });
}

/** Open the ⋯ menu for a configured agent row. */
function openAgentMenu(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${name}` }));
}

beforeEach(() => {
  invokeMock.mockReset();
  useAcpAgents.setState({ agents: [agent()], loading: false, error: null, adapters: [], acpStatus: {} });
  useCommitAgentMessages.setState({
    messages: DEFAULT_COMMIT_AGENT_MESSAGES,
    loading: false,
    error: null,
  });
  useRepo.setState({
    summary: { path: "/repo", workdir: "/repo", headBranch: "main", headOid: "a", detached: false },
  });
  useUi.setState({ confirm: null });
});

describe("AiAgentsSettings", () => {
  it("adds a supported adapter as an agent, which is what puts it in the menus", async () => {
    // Knowing an agent is supported does nothing on its own: the Draft and
    // Describe menus list the user's *agents*, so the catalogue needs a way
    // across.
    stubBackend();
    render(<AiAgentsSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Add" }));

    const names = screen.getAllByLabelText("Agent name").map((i) => (i as HTMLInputElement).value);
    expect(names).toContain("Cursor");

    fireEvent.click(screen.getByRole("button", { name: "Save agents" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("acp_agents_set", {
        agents: expect.arrayContaining([
          expect.objectContaining({ name: "Cursor", command: "cursor-agent acp" }),
        ]),
      }),
    );
  });

  it("names a second agent for the same adapter distinctly", async () => {
    // Two agents on one adapter is how two models stay a click apart, and the
    // menus list agents by name. "Add another profile" lives on the row menu.
    stubBackend();
    render(<AiAgentsSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    openAgentMenu("Cursor");
    fireEvent.click(screen.getByRole("menuitem", { name: "Add another profile" }));

    expect(screen.getByLabelText("Agent name")).toHaveValue("Cursor 2");
    expect(screen.getByRole("button", { name: "Actions for Cursor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actions for Cursor 2" })).toBeInTheDocument();
  });

  it("probes on expand, so the model list is there without pressing Connect", async () => {
    stubBackend();
    invokeMock.mockImplementation((command: string) => {
      if (command === "acp_agents_get") return Promise.resolve([agent()]);
      if (command === "acp_adapters") return Promise.resolve([adapter()]);
      if (command === "acp_probe")
        return Promise.resolve({
          agentName: "Codex",
          agentVersion: "1.1.14",
          currentModelId: "gpt-5.6-luna[medium]",
          models: [{ id: "gpt-5.6-sol[low]", name: "GPT-5.6-Sol (low)", description: "" }],
          configOptions: [],
        });
      return Promise.resolve();
    });
    render(<AiAgentsSettings />);

    openAgentMenu("Claude Code");
    fireEvent.click(screen.getByRole("menuitem", { name: "Configure…" }));

    expect(await screen.findByRole("option", { name: "GPT-5.6-Sol (low)" })).toBeInTheDocument();
  });

  it("refuses a second agent for an adapter that offers no model or effort choice", async () => {
    // Without models or thought_level options, a duplicate would be identical
    // in every respect — the only reason to have two is two pins.
    stubBackend([agent({ command: "cursor-agent acp", name: "Cursor" })]);
    useAcpAgents.setState({
      agents: [agent({ command: "cursor-agent acp", name: "Cursor" })],
      acpStatus: {
        "cursor-agent acp": {
          state: "ok",
          probe: {
            agentName: "Cursor",
            agentVersion: "1",
            currentModelId: "",
            models: [],
            configOptions: [],
          },
        },
      },
    });
    render(<AiAgentsSettings />);

    const add = await screen.findByRole("button", { name: "Added" });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute(
      "title",
      expect.stringContaining("already in your list"),
    );

    openAgentMenu("Cursor");
    const another = screen.getByRole("menuitem", { name: "Add another profile" });
    expect(another).toBeDisabled();
    expect(another).toHaveAttribute("title", expect.stringContaining("offers no model or effort choice"));
  });

  it("shows Effort when the probe advertises a thought_level option", async () => {
    stubBackend();
    invokeMock.mockImplementation((command: string) => {
      if (command === "acp_agents_get") return Promise.resolve([agent()]);
      if (command === "acp_adapters") return Promise.resolve([adapter()]);
      if (command === "acp_probe")
        return Promise.resolve({
          agentName: "Claude",
          agentVersion: "0.66.0",
          currentModelId: "opus[1m]",
          models: [
            { id: "opus[1m]", name: "Opus", description: "" },
            { id: "haiku", name: "Haiku", description: "" },
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
        });
      if (command === "commit_agent_messages_get")
        return Promise.resolve(DEFAULT_COMMIT_AGENT_MESSAGES);
      return Promise.resolve();
    });
    render(<AiAgentsSettings />);

    openAgentMenu("Claude Code");
    fireEvent.click(screen.getByRole("menuitem", { name: "Configure…" }));

    expect(await screen.findByRole("combobox", { name: "Effort" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "High" })).toBeInTheDocument();
  });

  it("uses a searchable model picker when the adapter returns many models", async () => {
    stubBackend();
    const models = Array.from({ length: 12 }, (_, i) => ({
      id: `model-${i}`,
      name: `Model ${i}`,
      description: "",
    }));
    invokeMock.mockImplementation((command: string) => {
      if (command === "acp_agents_get") return Promise.resolve([agent()]);
      if (command === "acp_adapters") return Promise.resolve([adapter()]);
      if (command === "acp_probe")
        return Promise.resolve({
          agentName: "Cursor",
          agentVersion: "1",
          currentModelId: "model-0",
          models,
          configOptions: [],
        });
      if (command === "commit_agent_messages_get")
        return Promise.resolve(DEFAULT_COMMIT_AGENT_MESSAGES);
      return Promise.resolve();
    });
    render(<AiAgentsSettings />);

    openAgentMenu("Claude Code");
    fireEvent.click(screen.getByRole("menuitem", { name: "Configure…" }));

    const picker = await screen.findByRole("combobox", { name: "Model" });
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: "Model 11" } });
    expect(await screen.findByRole("option", { name: "Model 11" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Model 0" })).not.toBeInTheDocument();
  });

  it("offers Cursor effort variants as selectable models from --list-models", async () => {
    // ACP only advertises one preset per model; the CLI list has low/medium/high
    // × fast as separate ids, so changing effort means picking a different model.
    stubBackend([
      agent({
        command: "cursor-agent acp",
        model: "cursor-grok-4.5-high",
      }),
    ]);
    invokeMock.mockImplementation((command: string) => {
      if (command === "acp_agents_get")
        return Promise.resolve([
          agent({
            command: "cursor-agent acp",
            model: "cursor-grok-4.5-high",
          }),
        ]);
      if (command === "acp_adapters")
        return Promise.resolve([
          adapter({ id: "cursor", name: "Cursor", command: "cursor-agent acp" }),
        ]);
      if (command === "acp_probe")
        return Promise.resolve({
          agentName: "Cursor",
          agentVersion: "1",
          currentModelId: "grok-4.5[effort=high,fast=true]",
          models: [
            { id: "cursor-grok-4.5-low", name: "Cursor Grok 4.5 Low", description: "" },
            { id: "cursor-grok-4.5-high", name: "Cursor Grok 4.5", description: "" },
            {
              id: "cursor-grok-4.5-high-fast",
              name: "Cursor Grok 4.5 Fast",
              description: "",
            },
          ],
          configOptions: [],
        });
      if (command === "commit_agent_messages_get")
        return Promise.resolve(DEFAULT_COMMIT_AGENT_MESSAGES);
      return Promise.resolve();
    });
    render(<AiAgentsSettings />);

    openAgentMenu("Claude Code");
    fireEvent.click(screen.getByRole("menuitem", { name: "Configure…" }));

    const model = await screen.findByRole("combobox", { name: "Model" });
    expect(model).toHaveValue("cursor-grok-4.5-high");
    expect(screen.getByRole("option", { name: "Cursor Grok 4.5 Low" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Cursor Grok 4.5 Fast" })).toBeInTheDocument();
    // No separate read-only Effort control — variants live in the model list.
    expect(screen.queryByText("Effort")).not.toBeInTheDocument();
  });

  it("shows baked-in effort chips when the adapter locks them into the model id", async () => {
    stubBackend([
      agent({
        command: "cursor-agent acp",
        model: "grok-4.5[effort=high,fast=true]",
      }),
    ]);
    invokeMock.mockImplementation((command: string) => {
      if (command === "acp_agents_get")
        return Promise.resolve([
          agent({
            command: "cursor-agent acp",
            model: "grok-4.5[effort=high,fast=true]",
          }),
        ]);
      if (command === "acp_adapters") return Promise.resolve([adapter()]);
      if (command === "acp_probe")
        return Promise.resolve({
          agentName: "Cursor",
          agentVersion: "1",
          currentModelId: "grok-4.5[effort=high,fast=true]",
          models: [
            {
              id: "grok-4.5[effort=high,fast=true]",
              name: "grok-4.5",
              description: "",
            },
          ],
          configOptions: [],
        });
      if (command === "commit_agent_messages_get")
        return Promise.resolve(DEFAULT_COMMIT_AGENT_MESSAGES);
      return Promise.resolve();
    });
    render(<AiAgentsSettings />);

    openAgentMenu("Claude Code");
    fireEvent.click(screen.getByRole("menuitem", { name: "Configure…" }));

    expect(await screen.findByText("Effort")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("Fast")).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
  });

  it("owns the agent instructions, which drive Draft and Describe", async () => {
    // They moved here from Terminal Agents: two of the three actions they
    // configure are ACP-only, so the terminal page was the wrong home.
    stubBackend();
    render(<AiAgentsSettings />);

    const save = await screen.findByRole("button", { name: "Save instructions" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Describe changes instruction" }), {
      target: { value: "Explain the user-visible behavior." },
    });
    fireEvent.click(save);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("commit_agent_messages_set", {
        messages: expect.objectContaining({
          descriptionInstruction: "Explain the user-visible behavior.",
        }),
      }),
    );
    // Instructions save on their own; the agent list is untouched.
    expect(invokeMock).not.toHaveBeenCalledWith("acp_agents_set", expect.anything());
  });

  it("keeps Save disabled until the draft changes, and requires a name", async () => {
    stubBackend();
    render(<AiAgentsSettings />);

    const save = await screen.findByRole("button", { name: "Save agents" });
    expect(save).toBeDisabled();

    openAgentMenu("Claude Code");
    fireEvent.click(screen.getByRole("menuitem", { name: "Configure…" }));

    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "" } });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Renamed" } });
    expect(save).toBeEnabled();
  });

  it("explains itself when nothing is configured yet", async () => {
    stubBackend([], []);
    useAcpAgents.setState({ agents: [] });
    render(<AiAgentsSettings />);

    expect(await screen.findByText(/No AI agents yet/)).toBeVisible();
  });

  it("folds the catalogue behind Ready / Needs install tabs with search", async () => {
    stubBackend(
      [],
      [
        adapter({ id: "cursor", name: "Cursor", available: true }),
        adapter({
          id: "goose",
          name: "Goose",
          command: "goose",
          available: false,
          install: "brew install block-goose-cli",
          requires: "Block's goose CLI.",
        }),
      ],
    );
    useAcpAgents.setState({ agents: [] });
    render(<AiAgentsSettings />);

    expect(await screen.findByText("ADD AN AGENT")).toBeVisible();
    expect(screen.getByRole("tab", { name: /Ready to use/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Cursor")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: /Needs install/ }));
    expect(screen.getByText("Goose")).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy install" })).toBeVisible();

    fireEvent.change(screen.getByLabelText("Search agents"), { target: { value: "nope" } });
    expect(screen.getByText(/No agents match that search/)).toBeVisible();
  });

  it("marks the first enabled agent as DEFAULT", async () => {
    stubBackend([
      agent({ id: "a", name: "First", enabled: true }),
      agent({ id: "b", name: "Second", enabled: true, command: "cursor-agent acp" }),
    ]);
    useAcpAgents.setState({
      agents: [
        agent({ id: "a", name: "First", enabled: true }),
        agent({ id: "b", name: "Second", enabled: true, command: "cursor-agent acp" }),
      ],
    });
    render(<AiAgentsSettings />);

    const defaultBadges = await screen.findAllByText("DEFAULT");
    expect(defaultBadges).toHaveLength(1);
    expect(screen.getByText("First")).toBeVisible();
    expect(screen.getByText("Second")).toBeVisible();
  });
});
