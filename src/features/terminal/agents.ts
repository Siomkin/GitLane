import type { TerminalAgent } from "@/lib/api";

/** Pure: keep only the enabled agents, preserving the input order. The toolbar
 * renders these as buttons. Visibility now comes from each agent's `enabled`
 * flag (set in Settings) — there's no separate id allowlist anymore. */
export function selectEnabledAgents(agents: TerminalAgent[]): TerminalAgent[] {
  return agents.filter((a) => a.enabled);
}
