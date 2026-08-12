// Lets the in-app agent menus switch an agent's model where the agent is used,
// instead of only in Settings.
//
// The model is part of the agent's saved config, so picking one writes through
// to the backend immediately — no draft, no Save button. That is the whole
// point: the Settings editor's draft/Save cycle is what made switching models
// feel like it wasn't possible.

import { useCallback } from "react";
import type { AcpAgent, AcpModel } from "@/lib/api";
import { useAcpAgents } from "@/store/acpAgents";
import { useRepo } from "@/store/repo";

export interface AgentModelPicker {
  /** Models this agent's adapter offers, empty until probed (or if it offers none). */
  modelsFor: (agent: AcpAgent) => AcpModel[];
  /** True while this agent's adapter is being asked what it offers. */
  isLoading: (agent: AcpAgent) => boolean;
  /** Probe the adapter unless it has already answered. Launches a process, so
   *  call it on an explicit click — not on hover or focus. */
  ensureProbed: (agent: AcpAgent) => void;
  /** Pin `agent` to `modelId` ("" = adapter default) and persist it. */
  pick: (agent: AcpAgent, modelId: string) => Promise<void>;
}

const NO_MODELS: AcpModel[] = [];

export function useAgentModelPicker(): AgentModelPicker {
  const acpStatus = useAcpAgents((s) => s.acpStatus);

  const modelsFor = useCallback(
    (agent: AcpAgent) => {
      const status = acpStatus[agent.command.trim()];
      return status?.state === "ok" ? status.probe.models : NO_MODELS;
    },
    [acpStatus],
  );

  const isLoading = useCallback(
    (agent: AcpAgent) => acpStatus[agent.command.trim()]?.state === "checking",
    [acpStatus],
  );

  const ensureProbed = useCallback((agent: AcpAgent) => {
    const command = agent.command.trim();
    const repoPath = useRepo.getState().summary?.path;
    if (!command || !repoPath) return;
    // A cached ok/failed answer stands — only a never-probed adapter is launched.
    if (useAcpAgents.getState().acpStatus[command]) return;
    void useAcpAgents.getState().probeAcp(command, repoPath);
  }, []);

  const pick = useCallback(async (agent: AcpAgent, modelId: string) => {
    if (agent.model === modelId) return;
    // Read the list at execution time, not from the render that created this
    // callback: saveAgents replaces the whole list, so two quick picks off one
    // stale snapshot would have the second undo the first.
    const current = useAcpAgents.getState().agents;
    await useAcpAgents
      .getState()
      .saveAgents(current.map((a) => (a.id === agent.id ? { ...a, model: modelId } : a)));
  }, []);

  return { modelsFor, isLoading, ensureProbed, pick };
}
