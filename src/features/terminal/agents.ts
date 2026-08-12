import type { TerminalAgent } from "@/lib/api";

/** Pure: keep only the enabled agents, preserving the input order. The terminal
 * toolbar renders these as launch buttons (an agent whose command isn't on PATH
 * is greyed out rather than hidden). Visibility comes from each agent's
 * `enabled` flag (set in Settings) — there's no separate id allowlist anymore. */
export function selectEnabledAgents(agents: TerminalAgent[]): TerminalAgent[] {
  return agents.filter((a) => a.enabled);
}
