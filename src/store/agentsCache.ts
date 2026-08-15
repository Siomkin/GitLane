// Shared frontend cache for a backend-owned agent list (terminal commands or
// ACP agents). The two stores differ only in which three `api.*` calls they
// make; the stale-response and mount-dedupe story is identical (GL-377).

import { requestLease } from "./requestLease";

export interface AgentsCacheState<A> {
  agents: A[];
  loading: boolean;
  error: string | null;
  /** Load (or reload) agents from the backend. Idempotent while in flight. */
  loadAgents: () => Promise<void>;
  /** Replace the full list, then reload so `available` is freshly probed. */
  saveAgents: (agents: A[]) => Promise<void>;
  /** Reset to the shipped defaults (writes through to the config file). */
  resetAgents: () => Promise<void>;
}

export interface AgentsCacheApi<A> {
  get: () => Promise<A[] | null | undefined>;
  set: (agents: A[]) => Promise<void>;
  reset: () => Promise<A[] | null | undefined>;
}

/** One latest-claim-wins cache over a `{ get, set, reset }` api triple.
 *  `loadInFlight` is a separate mount-dedupe flag (toolbar + Settings both load
 *  on mount) — not the lease. */
export function createAgentsCache<A>({
  get,
  set,
  reset,
}: AgentsCacheApi<A>): (publish: (partial: Partial<AgentsCacheState<A>>) => void) => AgentsCacheState<A> {
  const lease = requestLease();
  let loadInFlight = false;

  return (publish) => ({
    agents: [],
    loading: false,
    error: null,

    loadAgents: async () => {
      if (loadInFlight) return;
      loadInFlight = true;
      const token = lease.claim();
      publish({ loading: true });
      try {
        // A backend that answers with nothing must not blank the list: every
        // consumer filters it, and `undefined.filter` crashes the render.
        const agents = (await get()) ?? [];
        if (lease.isCurrent(token)) publish({ agents, error: null });
      } catch (e) {
        if (lease.isCurrent(token)) {
          publish({ error: String(e instanceof Error ? e.message : e) });
        }
      } finally {
        loadInFlight = false;
        if (lease.isCurrent(token)) publish({ loading: false });
      }
    },

    saveAgents: async (agents) => {
      await set(agents);
      // Reload so each agent's `available` reflects the just-saved command, and
      // claim a fresh lease so any load still in flight (which may have read
      // the pre-save file) can't overwrite this result when it resolves later.
      const token = lease.claim();
      const fresh = (await get()) ?? [];
      if (lease.isCurrent(token)) publish({ agents: fresh, error: null });
    },

    resetAgents: async () => {
      const token = lease.claim();
      const agents = (await reset()) ?? [];
      if (lease.isCurrent(token)) publish({ agents, error: null });
    },
  });
}
