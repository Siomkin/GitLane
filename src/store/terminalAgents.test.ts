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

/** A promise plus its resolver, to control async ordering deterministically. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  invokeMock.mockReset();
  useTerminalAgents.setState({ agents: [], loading: false, error: null });
});

describe("useTerminalAgents", () => {
  it("loadAgents populates from the backend and clears loading", async () => {
    invokeMock.mockResolvedValueOnce([agent("x")]); // terminal_agents_get
    await useTerminalAgents.getState().loadAgents();
    expect(useTerminalAgents.getState().agents).toEqual([agent("x")]);
    expect(useTerminalAgents.getState().loading).toBe(false);
    expect(useTerminalAgents.getState().error).toBeNull();
  });

  it("a stale in-flight load cannot overwrite a newer save", async () => {
    const stale = [agent("stale")];
    const saved = [agent("saved")];
    const slowGet = deferred<TerminalAgent[]>();
    let getCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      // First get (loadAgents) hangs; the save's reload get returns `saved`.
      if (cmd === "terminal_agents_get")
        return getCalls++ === 0 ? slowGet.promise : Promise.resolve(saved);
      if (cmd === "terminal_agents_set") return Promise.resolve();
      return Promise.resolve(stale);
    });

    const store = useTerminalAgents.getState();
    const loadP = store.loadAgents(); // gen 1 — get pending
    await store.saveAgents(saved); // gen 2 — write + reload wins
    expect(useTerminalAgents.getState().agents).toEqual(saved);

    slowGet.resolve(stale); // the superseded load finally resolves…
    await loadP;
    expect(useTerminalAgents.getState().agents).toEqual(saved); // …and is ignored
  });

  it("a stale in-flight load cannot overwrite a newer reset", async () => {
    const stale = [agent("stale")];
    const defaults = [agent("opencode")];
    const slowGet = deferred<TerminalAgent[]>();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "terminal_agents_get") return slowGet.promise; // loadAgents — pending
      if (cmd === "terminal_agents_reset") return Promise.resolve(defaults);
      return Promise.resolve(stale);
    });

    const store = useTerminalAgents.getState();
    const loadP = store.loadAgents(); // gen 1 — get pending
    await store.resetAgents(); // gen 2 — reset wins
    expect(useTerminalAgents.getState().agents).toEqual(defaults);

    slowGet.resolve(stale);
    await loadP;
    expect(useTerminalAgents.getState().agents).toEqual(defaults);
  });

  it("records the error message when a load fails", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    await useTerminalAgents.getState().loadAgents();
    expect(useTerminalAgents.getState().error).toBe("boom");
    expect(useTerminalAgents.getState().loading).toBe(false);
  });
});
