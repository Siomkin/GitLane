// The composer's compact "Draft / Improve" affordance (commit panel redesign):
// one control that both picks the terminal agent and starts the draft. The
// last-used agent is highlighted with a check so the button reads as "draft
// with <agent>" at a glance.

import type { TerminalAgent } from "@/lib/api";
import { AgentActionControl } from "@/features/changes/AgentActionControl";

export function DraftAgentControl({
  agents,
  activeAgentId,
  improve,
  disabled,
  disabledTitle,
  onPick,
}: {
  /** The enabled terminal agents (may include ones not on PATH). */
  agents: TerminalAgent[];
  /** Id of the agent last used to draft, shown as the active choice. */
  activeAgentId: string | null;
  /** True once a message exists — the affordance flips from Draft to Improve. */
  improve: boolean;
  disabled: boolean;
  disabledTitle: string;
  onPick: (agent: TerminalAgent) => void;
}) {
  const label = improve ? "Improve" : "Draft";
  return (
    <AgentActionControl
      agents={agents}
      activeAgentId={activeAgentId}
      label={label}
      menuLabel={`${label} with`}
      menuAriaLabel={`${label} with agent`}
      disabled={disabled}
      disabledTitle={disabledTitle}
      onPick={onPick}
    />
  );
}
