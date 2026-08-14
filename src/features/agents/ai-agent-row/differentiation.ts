// Whether a second agent for the same adapter could differ from this one.

import { type AcpStatus } from "@/store/acpAgents";

export function canDifferentiate(status: AcpStatus): boolean {
  // Until probed we can't know, so assume a second one might be worth adding —
  // better than blocking an action that would have been valid.
  if (status.state !== "ok" || !status.probe) return true;
  return (
    status.probe.models.length > 0 ||
    status.probe.configOptions.some((option) => option.category === "thought_level")
  );
}
