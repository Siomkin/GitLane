// The user's AI agents — the ones that answer in-app requests (Draft / Improve,
// Describe) by speaking ACP to an adapter — plus the adapter catalogue and the
// probe results the model pickers read.
//
// Separate from `terminalAgents`, which owns commands typed into a terminal tab.
// They were one store while they were one record; the split is what stopped an
// agent's terminal availability from deciding whether it could answer in-app.
// The Rust config file is the source of truth; this is the shared cache.

import { create } from "zustand";
import { api, type AcpAdapter, type AcpAgent, type AcpProbe } from "@/lib/api";

/** What we know about one adapter command right now. `checking` while its probe
 *  runs; `ok` carries the adapter's identity and model list; `failed` carries
 *  the reason (not installed, not signed in, crashed on startup). */
export type AcpStatus =
  | { state: "unknown" }
  | { state: "checking" }
  | { state: "ok"; probe: AcpProbe }
  | { state: "failed"; error: string };

const UNKNOWN: AcpStatus = { state: "unknown" };

interface AcpAgentsState {
  agents: AcpAgent[];
  loading: boolean;
  error: string | null;
  /** The adapters GitLane knows how to launch; loaded once. */
  adapters: AcpAdapter[];
  /** Probe results keyed by adapter command — shared so the Settings rows, the
   *  catalogue card and the menu model pickers never probe the same command
   *  twice. */
  acpStatus: Record<string, AcpStatus>;
  loadAgents: () => Promise<void>;
  saveAgents: (agents: AcpAgent[]) => Promise<void>;
  resetAgents: () => Promise<void>;
  loadAdapters: () => Promise<void>;
  /** Launch `command` and ask what it is. Re-running replaces the cached
   *  result — that is how the user retries after installing or signing in. */
  probeAcp: (command: string, repoPath: string) => Promise<void>;
}

// Monotonic operation counter: an async result is applied only if it is still
// the latest claim, so a slow load can't clobber a newer save.
let generation = 0;
let loadInFlight = false;

export const useAcpAgents = create<AcpAgentsState>((set, get) => ({
  agents: [],
  loading: false,
  error: null,
  adapters: [],
  acpStatus: {},

  loadAgents: async () => {
    if (loadInFlight) return;
    loadInFlight = true;
    const gen = ++generation;
    set({ loading: true });
    try {
      // A backend that answers with nothing must not blank the list: every
      // consumer filters it, and `undefined.filter` crashes the render.
      const agents = (await api.acpAgentsGet()) ?? [];
      if (gen === generation) set({ agents, error: null });
    } catch (e) {
      if (gen === generation) set({ error: String(e instanceof Error ? e.message : e) });
    } finally {
      loadInFlight = false;
      if (gen === generation) set({ loading: false });
    }
  },

  saveAgents: async (agents) => {
    await api.acpAgentsSet(agents);
    // Reload so each agent's `available` reflects the just-saved command, and
    // claim a fresh generation so a load still in flight can't overwrite it.
    const gen = ++generation;
    const fresh = (await api.acpAgentsGet()) ?? [];
    if (gen === generation) set({ agents: fresh, error: null });
  },

  resetAgents: async () => {
    const gen = ++generation;
    const agents = (await api.acpAgentsReset()) ?? [];
    if (gen === generation) set({ agents, error: null });
  },

  loadAdapters: async () => {
    if (get().adapters.length) return;
    try {
      // Tolerate a backend that answers with nothing: losing the suggestions is
      // survivable, rendering `undefined.length` is not.
      set({ adapters: (await api.acpAdapters()) ?? [] });
    } catch {
      // A missing catalogue costs the suggestions, not the feature — the
      // adapter command is free text either way.
    }
  },

  probeAcp: async (command, repoPath) => {
    const key = command.trim();
    if (!key) return;
    const patch = (status: AcpStatus) =>
      set((s) => ({ acpStatus: { ...s.acpStatus, [key]: status } }));
    patch({ state: "checking" });
    try {
      patch({ state: "ok", probe: await api.acpProbe(key, repoPath) });
    } catch (e) {
      patch({ state: "failed", error: String(e instanceof Error ? e.message : e) });
    }
  },
}));

/** Selector for one command's probe state — stable identity while unchanged, so
 *  a row re-renders only when its own adapter's status moves. */
export const acpStatusOf = (command: string) => (s: AcpAgentsState) =>
  s.acpStatus[command.trim()] ?? UNKNOWN;

/** The agents an in-app action can offer: enabled, with an adapter command.
 *  Deliberately not gated on `available`, which probes PATH — an adapter run
 *  through `npx` resolves at launch time, not lookup time. */
export function selectInAppAgents(agents: AcpAgent[]): AcpAgent[] {
  return agents.filter((agent) => agent.enabled && agent.command.trim() !== "");
}
