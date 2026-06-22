// The user-configurable terminal-agent list. The Rust config file
// (`terminal-agents.json` in the app data dir) is the source of truth; this
// store is the shared frontend cache so the Terminal toolbar and the Settings
// editor stay in sync after a save. Not a `persist` store — the file owns
// durability, and availability is re-probed on every backend read.

import { create } from "zustand";
import { api, type TerminalAgent } from "@/lib/api";

interface TerminalAgentsState {
  agents: TerminalAgent[];
  loading: boolean;
  error: string | null;
  /** Load (or reload) agents from the backend. Idempotent while in flight. */
  loadAgents: () => Promise<void>;
  /** Replace the full list, then reload so `available` is freshly probed. */
  saveAgents: (agents: TerminalAgent[]) => Promise<void>;
  /** Reset to the shipped defaults (writes through to the config file). */
  resetAgents: () => Promise<void>;
}

// Monotonic operation counter. Every load/save/reset claims the next value;
// an async result is only applied if it's still the latest claim. This makes a
// slow in-flight load unable to clobber a newer save/reset that finished first
// (results arriving out of order are simply dropped). `loadInFlight` dedupes
// the two mount-time loads (toolbar + Settings) so they don't double-probe PATH.
let generation = 0;
let loadInFlight = false;

export const useTerminalAgents = create<TerminalAgentsState>((set) => ({
  agents: [],
  loading: false,
  error: null,

  loadAgents: async () => {
    if (loadInFlight) return;
    loadInFlight = true;
    const gen = ++generation;
    set({ loading: true });
    try {
      const agents = await api.terminalAgentsGet();
      if (gen === generation) set({ agents, error: null });
    } catch (e) {
      if (gen === generation) set({ error: String(e instanceof Error ? e.message : e) });
    } finally {
      loadInFlight = false;
      if (gen === generation) set({ loading: false });
    }
  },

  saveAgents: async (agents) => {
    await api.terminalAgentsSet(agents);
    // Reload so each agent's `available` reflects the just-saved command, and
    // claim a fresh generation so any load still in flight (which may have read
    // the pre-save file) can't overwrite this result when it resolves later.
    const gen = ++generation;
    const fresh = await api.terminalAgentsGet();
    if (gen === generation) set({ agents: fresh, error: null });
  },

  resetAgents: async () => {
    const gen = ++generation;
    const agents = await api.terminalAgentsReset();
    if (gen === generation) set({ agents, error: null });
  },
}));
