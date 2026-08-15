import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary; the real `lib/api` wrappers call this mocked `invoke`.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useTerminalAgents } from "./terminalAgents";
import type { TerminalAgent } from "@/lib/api";

const agent = (id: string): TerminalAgent => ({
  id,
  name: id,
  command: id,
  description: "",
  enabled: true,
  available: true,
});

beforeEach(() => {
  invokeMock.mockReset();
  useTerminalAgents.setState({ agents: [], loading: false, error: null });
});

describe("useTerminalAgents", () => {
  it("wires load, save, and reset to the terminal-agent commands", async () => {
    const listed = [agent("x")];
    const defaults = [agent("opencode")];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "terminal_agents_get") return Promise.resolve(listed);
      if (cmd === "terminal_agents_set") return Promise.resolve();
      if (cmd === "terminal_agents_reset") return Promise.resolve(defaults);
      return Promise.resolve([]);
    });

    await useTerminalAgents.getState().loadAgents();
    expect(invokeMock.mock.calls.map(([cmd]) => cmd)).toEqual(["terminal_agents_get"]);
    expect(useTerminalAgents.getState().agents).toEqual(listed);

    invokeMock.mockClear();
    await useTerminalAgents.getState().saveAgents(listed);
    expect(invokeMock.mock.calls.map(([cmd]) => cmd)).toEqual([
      "terminal_agents_set",
      "terminal_agents_get",
    ]);

    invokeMock.mockClear();
    await useTerminalAgents.getState().resetAgents();
    expect(invokeMock.mock.calls.map(([cmd]) => cmd)).toEqual(["terminal_agents_reset"]);
    expect(useTerminalAgents.getState().agents).toEqual(defaults);
  });
});
