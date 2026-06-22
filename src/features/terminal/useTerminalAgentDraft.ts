// Focused editor hook for the Terminal Agents settings panel. Owns the local
// `draft` (the user's in-progress edits), the per-row live PATH "Check" state,
// and the load/save/reset orchestration against the shared `useTerminalAgents`
// store. All draft mutations delegate to the pure helpers in `agentDraft.ts`, so
// the component is left with rendering only. IPC stays in the store/api.

import { useEffect, useRef, useState } from "react";
import { useUi } from "../../store/ui";
import { useTerminalAgents } from "../../store/terminalAgents";
import { api, type TerminalAgent } from "../../lib/api";
import {
  type AgentCheck,
  type CheckStatus,
  addAgent,
  agentSignature,
  areAgentsValid,
  bin,
  duplicateAgent,
  isDraftDirty,
  moveAgent,
  removeAgent,
  updateAgent,
} from "./agentDraft";

export interface TerminalAgentDraft {
  /** The last-saved list (source of truth for dirty/preview comparisons). */
  saved: TerminalAgent[];
  loading: boolean;
  error: string | null;
  /** The editable working copy committed to the backend on save. */
  draft: TerminalAgent[];
  saving: boolean;
  dirty: boolean;
  valid: boolean;
  /** Raw per-row check results, keyed by agent id (for the preview chips). */
  checks: Record<string, AgentCheck>;
  /** Live check status for a row, or "idle" when nothing has been probed for
   *  its current command. */
  checkOf: (agent: TerminalAgent) => CheckStatus | "idle";
  add: () => void;
  update: (id: string, patch: Partial<TerminalAgent>) => void;
  duplicate: (id: string) => void;
  /** Edit a command and forget any stale check tied to the previous value. */
  editCommand: (id: string, command: string) => void;
  /** Run the live PATH probe for one row's current command. */
  checkAgent: (id: string) => Promise<void>;
  move: (from: number, to: number) => void;
  /** Confirm-then-delete one agent (drops it from the draft on confirm). */
  confirmDelete: (agent: TerminalAgent) => void;
  save: () => Promise<void>;
  /** Confirm-then-reset the whole list to the shipped defaults. */
  reset: () => void;
}

export function useTerminalAgentDraft(): TerminalAgentDraft {
  const saved = useTerminalAgents((s) => s.agents);
  const loading = useTerminalAgents((s) => s.loading);
  const error = useTerminalAgents((s) => s.error);
  const loadAgents = useTerminalAgents((s) => s.loadAgents);
  const saveAgents = useTerminalAgents((s) => s.saveAgents);
  const resetAgents = useTerminalAgents((s) => s.resetAgents);
  const showToast = useUi((s) => s.showToast);
  const requestConfirm = useUi((s) => s.requestConfirm);

  // Editable draft: committed to the config file on Save. We only adopt a fresh
  // backend list when the draft is *pristine* (matches what we last showed), so
  // a background reload — e.g. another mount re-probing availability — can't
  // silently discard the user's unsaved edits. `syncedSig` tracks the signature
  // of the list the draft was last derived from.
  const [draft, setDraft] = useState<TerminalAgent[]>(saved);
  const [saving, setSaving] = useState(false);
  const syncedSig = useRef(agentSignature(saved));
  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);
  useEffect(() => {
    // Capture the previous synced signature *before* setDraft: the functional
    // updater runs on the next render, after this effect body, so reading
    // `syncedSig.current` inside it would see the already-reassigned new value
    // and never adopt a genuinely-changed backend list into a pristine draft.
    const prevSig = syncedSig.current;
    setDraft((cur) => (agentSignature(cur) === prevSig ? saved : cur));
    syncedSig.current = agentSignature(saved);
  }, [saved]);

  // Per-row "Check" result (idle until the user probes the typed command). The
  // generation counter lets a slow probe be ignored once its command changes.
  const [checks, setChecks] = useState<Record<string, AgentCheck>>({});
  const checkGeneration = useRef<Record<string, number>>({});
  const checkOf = (agent: TerminalAgent): CheckStatus | "idle" => {
    const check = checks[agent.id];
    return check?.command === agent.command ? check.status : "idle";
  };
  const setCheck = (id: string, check: AgentCheck) =>
    setChecks((current) => ({ ...current, [id]: check }));
  const clearCheck = (id: string) => {
    checkGeneration.current[id] = (checkGeneration.current[id] ?? 0) + 1;
    setChecks((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  };
  const clearAllChecks = () => {
    for (const id of Object.keys(checkGeneration.current)) {
      checkGeneration.current[id] += 1;
    }
    setChecks({});
  };

  const dirty = isDraftDirty(draft, saved);
  const valid = areAgentsValid(draft);

  const add = () => setDraft(addAgent);
  const update = (id: string, patch: Partial<TerminalAgent>) =>
    setDraft((d) => updateAgent(d, id, patch));
  const duplicate = (id: string) => setDraft((d) => duplicateAgent(d, id));
  const editCommand = (id: string, command: string) => {
    setDraft((d) => updateAgent(d, id, { command }));
    clearCheck(id);
  };
  const move = (from: number, to: number) => setDraft((d) => moveAgent(d, from, to));

  const checkAgent = async (id: string) => {
    const agent = draft.find((a) => a.id === id);
    if (!agent || !bin(agent.command)) {
      clearCheck(id);
      return;
    }
    const command = agent.command;
    const generation = (checkGeneration.current[id] ?? 0) + 1;
    checkGeneration.current[id] = generation;
    setCheck(id, { command, status: "checking" });
    try {
      const ok = await api.terminalAgentProbe(command);
      if (checkGeneration.current[id] !== generation) return;
      setCheck(id, { command, status: ok ? "found" : "missing" });
    } catch {
      if (checkGeneration.current[id] !== generation) return;
      setCheck(id, { command, status: "missing" });
    }
  };

  const confirmDelete = (agent: TerminalAgent) => {
    requestConfirm({
      title: "Delete agent?",
      message: `“${agent.name.trim() || "Untitled agent"}” will be removed from this draft. Save the changes to apply it.`,
      confirmLabel: "Delete agent",
      danger: true,
      onConfirm: () => {
        setDraft((d) => removeAgent(d, agent.id));
        clearCheck(agent.id);
      },
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveAgents(draft);
      clearAllChecks();
      showToast("Saved terminal agents");
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e), "error");
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    requestConfirm({
      title: "Reset terminal agents to defaults?",
      message: "Your custom agents and edits will be replaced with the four built-ins.",
      confirmLabel: "Reset",
      danger: true,
      onConfirm: async () => {
        try {
          await resetAgents();
          // Reset is an explicit, confirmed action: adopt the defaults even when
          // the draft was dirty (the pristine-only sync effect would otherwise
          // leave the user's stale edits in place, so "Reset" would appear to do
          // nothing). Re-baseline `syncedSig` so the draft reads as clean.
          const fresh = useTerminalAgents.getState().agents;
          setDraft(fresh);
          syncedSig.current = agentSignature(fresh);
          clearAllChecks();
          showToast("Reset to default agents");
        } catch (e) {
          showToast(String(e instanceof Error ? e.message : e), "error");
        }
      },
    });
  };

  return {
    saved,
    loading,
    error,
    draft,
    saving,
    dirty,
    valid,
    checks,
    checkOf,
    add,
    update,
    duplicate,
    editCommand,
    checkAgent,
    move,
    confirmDelete,
    save,
    reset,
  };
}
