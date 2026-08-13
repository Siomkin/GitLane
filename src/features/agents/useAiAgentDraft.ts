// Editor state for the AI Agents settings panel: per-row Save for field edits,
// immediate persist for list ops (add, delete, reorder, enable). Same shape as
// the Prompts panel — a page-level Save would be a second commit for work the
// row already owns.

import { useEffect, useRef, useState } from "react";
import type { AcpAdapter, AcpAgent } from "@/lib/api";
import { useDraftPersist } from "@/hooks/useDraftPersist";
import { useAcpAgents } from "@/store/acpAgents";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { uniqueAgentName } from "./acpFields";

/** Compact signature of the editable fields — ignores `available`, which the
 *  backend recomputes on every read, so an availability refresh never reads as
 *  a pending edit. */
function signature(list: AcpAgent[]): string {
  return JSON.stringify(
    list.map(({ id, name, command, model, config, description, enabled }) => ({
      id,
      name,
      command,
      model,
      config,
      description,
      enabled,
    })),
  );
}

/** Fields the row Save commits. Enable is persisted immediately, so it is not
 *  part of "something changed in this editor". */
function editSignature(agent: AcpAgent): string {
  return JSON.stringify({
    name: agent.name,
    command: agent.command,
    model: agent.model,
    config: agent.config,
    description: agent.description,
  });
}

/** An agent is usable once it has a name and an adapter to launch. */
export function isAiAgentValid(agent: AcpAgent): boolean {
  return agent.name.trim() !== "" && agent.command.trim() !== "";
}

/** Build the list that should hit disk. Open editors fall back to what is
 *  already saved (except `enabled`, which the switch writes immediately), so
 *  saving one row or toggling another cannot commit a half-typed name. A new
 *  unsaved row is omitted until its own Save. Returns null when a row being
 *  written is invalid — the caller keeps the editor open. */
export function persistableAgents(
  draft: AcpAgent[],
  saved: AcpAgent[],
  editingIds: ReadonlySet<string>,
): AcpAgent[] | null {
  const savedById = new Map(saved.map((agent) => [agent.id, agent]));
  const next: AcpAgent[] = [];
  for (const agent of draft) {
    if (editingIds.has(agent.id)) {
      const fromSaved = savedById.get(agent.id);
      if (!fromSaved) continue;
      next.push({ ...fromSaved, enabled: agent.enabled });
      continue;
    }
    if (!isAiAgentValid(agent)) return null;
    next.push(agent);
  }
  return next;
}

function makeAgent(
  names: string[],
  fields: { name: string; command: string; available: boolean },
): AcpAgent {
  return {
    id: crypto.randomUUID(),
    name: uniqueAgentName(fields.name, names),
    command: fields.command,
    model: "",
    config: {},
    description: "",
    enabled: true,
    available: fields.available,
  };
}

export interface AiAgentDraft {
  draft: AcpAgent[];
  adapters: AcpAdapter[];
  error: string | null;
  saving: boolean;
  /** Is this row expanded into its editor? Newly added rows open expanded. */
  isEditing: (id: string) => boolean;
  isDirty: (id: string) => boolean;
  canSave: (id: string) => boolean;
  startEdit: (id: string) => void;
  saveEdit: (id: string) => void;
  cancelEdit: (id: string) => void;
  collapse: (id: string) => void;
  update: (id: string, patch: Partial<AcpAgent>) => void;
  /** Append an agent for a catalogue adapter; repeatable, so one adapter can
   *  back several agents pinned to different models. */
  addFromAdapter: (adapter: AcpAdapter) => void;
  /** Blank custom ACP adapter — any command that speaks the protocol over stdio. */
  addCustom: () => void;
  /** Another agent for the same adapter command (second model / effort pin). */
  addAnother: (id: string) => void;
  confirmDelete: (agent: AcpAgent) => void;
  /** Reorder: the list order is the order the Draft / Describe menus offer. */
  move: (from: number, to: number) => void;
  /** Probe this row's adapter (identity + model list). */
  connect: (id: string) => Promise<void>;
  reset: () => void;
}

export function useAiAgentDraft(): AiAgentDraft {
  const saved = useAcpAgents((s) => s.agents);
  const error = useAcpAgents((s) => s.error);
  const adapters = useAcpAgents((s) => s.adapters);
  const loadAgents = useAcpAgents((s) => s.loadAgents);
  const loadAdapters = useAcpAgents((s) => s.loadAdapters);
  const saveAgents = useAcpAgents((s) => s.saveAgents);
  const resetAgents = useAcpAgents((s) => s.resetAgents);
  const showToast = useUi((s) => s.showToast);
  const requestConfirm = useUi((s) => s.requestConfirm);

  const [editingId, setEditingId] = useState<string | null>(null);
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;

  const { draft, draftRef, savedRef, saving, apply, persistNow, persistNowRef } = useDraftPersist(
    saved,
    signature,
    (d, s, saveId) => {
      const editing = new Set(editingIdRef.current ? [editingIdRef.current] : []);
      if (saveId) editing.delete(saveId);
      return persistableAgents(d, s, editing);
    },
    saveAgents,
  );

  useEffect(() => {
    void loadAgents();
    void loadAdapters();
  }, [loadAgents, loadAdapters]);

  const setEditing = (id: string | null) => {
    editingIdRef.current = id;
    setEditingId(id);
  };

  /** Put a row back to disk without collapsing — used when the user opens
   *  another editor without Save, so the abandoned name never hits persist. */
  const revertFields = (id: string) => {
    const fromSaved = savedRef.current.find((a) => a.id === id);
    if (!fromSaved) {
      apply((d) => d.filter((a) => a.id !== id));
      return;
    }
    apply((d) =>
      d.map((a) =>
        a.id === id
          ? {
              ...a,
              name: fromSaved.name,
              command: fromSaved.command,
              model: fromSaved.model,
              config: fromSaved.config,
              description: fromSaved.description,
            }
          : a,
      ),
    );
  };

  const abandonOpenEditor = () => {
    const cur = editingIdRef.current;
    if (cur) revertFields(cur);
  };

  const update = (id: string, patch: Partial<AcpAgent>) => {
    apply((d) => d.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    if ("enabled" in patch) void persistNow();
  };

  const addFromAdapter = (adapter: AcpAdapter) => {
    abandonOpenEditor();
    const id = crypto.randomUUID();
    apply((d) => [
      ...d,
      {
        ...makeAgent(d.map((a) => a.name), {
          name: adapter.name,
          command: adapter.command,
          available: adapter.available,
        }),
        id,
      },
    ]);
    setEditing(id);
    void persistNow(id);
  };

  const addCustom = () => {
    abandonOpenEditor();
    const id = crypto.randomUUID();
    apply((d) => [
      ...d,
      {
        ...makeAgent(d.map((a) => a.name), {
          name: "Custom agent",
          command: "",
          available: true,
        }),
        id,
      },
    ]);
    setEditing(id);
  };

  const addAnother = (id: string) => {
    abandonOpenEditor();
    const nextId = crypto.randomUUID();
    apply((d) => {
      const source = d.find((a) => a.id === id);
      if (!source) return d;
      const adapter = adapters.find((a) => a.command === source.command);
      const baseName =
        (adapter?.name ?? source.name.replace(/\s+\d+$/, "").trim()) || "Agent";
      const agent = {
        ...makeAgent(d.map((a) => a.name), {
          name: baseName,
          command: source.command,
          available: source.available,
        }),
        id: nextId,
      };
      const idx = d.findIndex((a) => a.id === id);
      const next = [...d];
      next.splice(idx + 1, 0, agent);
      return next;
    });
    setEditing(nextId);
    void persistNow(nextId);
  };

  const move = (from: number, to: number) => {
    apply((d) => {
      if (from === to || from < 0 || to < 0 || from >= d.length || to >= d.length) return d;
      const next = [...d];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
    void persistNow();
  };

  const confirmDelete = (agent: AcpAgent) =>
    requestConfirm({
      title: `Delete ${agent.name || "this agent"}?`,
      message: "It will no longer be offered by Draft, Improve or AI actions.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        apply((d) => d.filter((a) => a.id !== agent.id));
        if (editingIdRef.current === agent.id) setEditing(null);
        void persistNowRef.current();
      },
    });

  const connect = async (id: string) => {
    const agent = draftRef.current.find((a) => a.id === id);
    if (!agent?.command.trim()) return;
    // No repo open is not a reason to refuse. These settings are global, and
    // requiring one made Connect a button that silently did nothing on the
    // first screen a new user sees — the backend picks a home-dir cwd instead.
    const repoPath = useRepo.getState().summary?.path ?? "";
    await useAcpAgents.getState().probeAcp(agent.command, repoPath);
  };

  const isDirty = (id: string) => {
    const current = draft.find((a) => a.id === id);
    if (!current) return false;
    const fromSaved = saved.find((a) => a.id === id);
    if (!fromSaved) return true;
    return editSignature(current) !== editSignature(fromSaved);
  };

  const canSave = (id: string) => {
    const current = draft.find((a) => a.id === id);
    return !!current && isDirty(id) && isAiAgentValid(current) && !saving;
  };

  const saveEdit = (id: string) => {
    void persistNow(id).then((ok) => {
      if (ok && editingIdRef.current === id) setEditing(null);
    });
  };

  const cancelEdit = (id: string) => {
    revertFields(id);
    if (editingIdRef.current === id) setEditing(null);
  };

  const collapse = (id: string) => {
    if (isDirty(id)) return;
    if (editingIdRef.current === id) setEditing(null);
  };

  const reset = () =>
    requestConfirm({
      title: "Reset AI agents?",
      message: "Your list is replaced by the agents GitLane detects on this machine.",
      confirmLabel: "Reset",
      danger: true,
      onConfirm: () => {
        setEditing(null);
        void resetAgents().catch((e: unknown) =>
          showToast(String(e instanceof Error ? e.message : e), "error"),
        );
      },
    });

  return {
    draft,
    adapters,
    error,
    saving,
    isEditing: (id) => editingId === id,
    isDirty,
    canSave,
    startEdit: (id) => {
      if (editingIdRef.current && editingIdRef.current !== id) revertFields(editingIdRef.current);
      setEditing(id);
    },
    saveEdit,
    cancelEdit,
    collapse,
    update,
    addFromAdapter,
    addCustom,
    addAnother,
    confirmDelete,
    move,
    connect,
    reset,
  };
}
