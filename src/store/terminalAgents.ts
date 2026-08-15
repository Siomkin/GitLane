// The user-configurable terminal-agent list. The Rust config file
// (`terminal-agents.json` in the app data dir) is the source of truth; this
// store is the shared frontend cache so the Terminal toolbar and the Settings
// editor stay in sync after a save. Not a `persist` store — the file owns
// durability, and availability is re-probed on every backend read.

import { create } from "zustand";
import { api, type TerminalAgent } from "@/lib/api";
import { createAgentsCache, type AgentsCacheState } from "./agentsCache";

export type TerminalAgentsState = AgentsCacheState<TerminalAgent>;

export const useTerminalAgents = create<TerminalAgentsState>()(
  createAgentsCache({
    get: api.terminalAgentsGet,
    set: api.terminalAgentsSet,
    reset: api.terminalAgentsReset,
  }),
);
