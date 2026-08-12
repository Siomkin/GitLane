// Terminal-agent fixtures shared by the tests that drive agent actions.

import type { AcpAgent, TerminalAgent } from "@/lib/api";

/** An agent launched into a terminal tab. */
export function terminalAgent(command: string, over: Partial<TerminalAgent> = {}): TerminalAgent {
  return {
    id: command,
    name: command,
    command,
    description: "",
    enabled: true,
    available: true,
    ...over,
  };
}

/** An AI agent — the kind that answers Draft / Describe over ACP. Its `command`
 *  is an adapter, not a shell command; the two lists are unrelated. */
export function acpAgent(name: string, over: Partial<AcpAgent> = {}): AcpAgent {
  return {
    id: name,
    name,
    command: `${name}-acp`,
    model: "",
    config: {},
    description: "",
    enabled: true,
    available: true,
    ...over,
  };
}
