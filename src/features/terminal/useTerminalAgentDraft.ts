// Focused editor hook for the Terminal Agents settings panel. Owns the local
// `draft` (the user's in-progress edits), the per-row live PATH "Check" state,
// and the load/save/reset orchestration against the shared `useTerminalAgents`
// store. All draft mutations delegate to the pure helpers in `agentDraft.ts`, so
// the component is left with rendering only. IPC stays in the store/api.

import { useEffect, useRef, useState } from "react";
import { useDraftState } from "@/hooks/useDraftState";
import { useUi } from "@/store/ui";
import { useTerminalAgents } from "@/store/terminalAgents";
// eslint-disable-next-line no-restricted-imports -- feature hook owning the terminal-agent probe (architecture-rules-react.md §1)
import { api, type TerminalAgent } from "@/lib/api";
import {
  type AgentCheck,
  type CheckStatus,
  agentSignature,
  areAgentsValid,
  bin,
  blankAgent,
  copyOf,
  insertAfter,
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
  /** Is this row expanded into its editor? Rows are compact (view-only) until
   *  opened, and newly added / duplicated rows open expanded. Transient UI
   *  state — never part of the saved list. */
  isEditing: (id: string) => boolean;
  /** Expand a row into its editor. */
  startEdit: (id: string) => void;
  /** Collapse a row back to its compact view. */
  stopEdit: (id: string) => void;
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

  // Editable draft: committed to the config file on Save. No `useDraftPersist`
  // here — this panel saves as a page, so there must be no unmount flush.
  const { draft, apply, adopt } = useDraftState(saved, agentSignature);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

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

  // Which rows are expanded into their editor. Purely transient view state kept
  // out of `draft` so it never enters the saved signature. New/duplicated rows
  // open expanded; ids that leave the draft are pruned on delete/reset.
  const [editingIds, setEditingIds] = useState<Set<string>>(() => new Set());
  const isEditing = (id: string) => editingIds.has(id);
  const startEdit = (id: string) =>
    setEditingIds((s) => (s.has(id) ? s : new Set(s).add(id)));
  const stopEdit = (id: string) =>
    setEditingIds((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });

  const dirty = isDraftDirty(draft, saved);
  const valid = areAgentsValid(draft);

  const add = () => {
    const row = blankAgent();
    apply((d) => [...d, row]);
    startEdit(row.id);
  };
  const update = (id: string, patch: Partial<TerminalAgent>) =>
    apply((d) => updateAgent(d, id, patch));
  const duplicate = (id: string) => {
    const src = draft.find((a) => a.id === id);
    if (!src) return;
    const copy = copyOf(src);
    apply((d) => insertAfter(d, id, copy));
    startEdit(copy.id);
  };
  const editCommand = (id: string, command: string) => {
    apply((d) => updateAgent(d, id, { command }));
    clearCheck(id);
  };
  const move = (from: number, to: number) => apply((d) => moveAgent(d, from, to));

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
        apply((d) => removeAgent(d, agent.id));
        clearCheck(agent.id);
        stopEdit(agent.id);
      },
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveAgents(draft);
      clearAllChecks();
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
          // the draft was dirty (pristine-only adoption would otherwise leave
          // the user's stale edits in place, so "Reset" would appear to do
          // nothing).
          adopt(useTerminalAgents.getState().agents);
          clearAllChecks();
          setEditingIds(new Set());
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
    isEditing,
    startEdit,
    stopEdit,
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
