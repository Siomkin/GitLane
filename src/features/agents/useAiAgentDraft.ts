// Editor state for the AI Agents settings panel: the in-progress draft, its
// validity, and save/reset/probe orchestration against `useAcpAgents`.
//
// Same draft-then-Save shape as the terminal-agent editor, deliberately: these
// are list edits (add, rename, delete, retarget), and committing each keystroke
// would write the config file on every character. The one thing that *does*
// save immediately is picking a model from the Draft/Describe menu — that is a
// single deliberate choice made where the agent is used, not a list edit.

import { useEffect, useState } from "react";
import type { AcpAdapter, AcpAgent } from "@/lib/api";
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

/** An agent is usable once it has a name and an adapter to launch. */
export function isAiAgentValid(agent: AcpAgent): boolean {
  return agent.name.trim() !== "" && agent.command.trim() !== "";
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
  dirty: boolean;
  valid: boolean;
  /** Is this row expanded into its editor? Newly added rows open expanded. */
  isEditing: (id: string) => boolean;
  startEdit: (id: string) => void;
  stopEdit: (id: string) => void;
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
  save: () => Promise<void>;
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

  const [draft, setDraft] = useState<AcpAgent[]>(saved);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Adopt a fresh backend list only while the draft is pristine, so a
  // background reload can't discard unsaved edits. Adjust during render
  // (architecture-rules-react.md §1) rather than syncing in an effect.
  const [baselineSig, setBaselineSig] = useState(() => signature(saved));
  const savedSig = signature(saved);
  if (savedSig !== baselineSig) {
    setBaselineSig(savedSig);
    if (signature(draft) === baselineSig) setDraft(saved);
  }

  useEffect(() => {
    void loadAgents();
    void loadAdapters();
  }, [loadAgents, loadAdapters]);

  const update = (id: string, patch: Partial<AcpAgent>) =>
    setDraft((d) => d.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  const addFromAdapter = (adapter: AcpAdapter) => {
    const id = crypto.randomUUID();
    setDraft((d) => [
      ...d,
      { ...makeAgent(d.map((a) => a.name), {
        name: adapter.name,
        command: adapter.command,
        available: adapter.available,
      }), id },
    ]);
    setEditingId(id);
  };

  const addCustom = () => {
    const id = crypto.randomUUID();
    setDraft((d) => [
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
    setEditingId(id);
  };

  const addAnother = (id: string) => {
    const nextId = crypto.randomUUID();
    setDraft((d) => {
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
    setEditingId(nextId);
  };

  const move = (from: number, to: number) =>
    setDraft((d) => {
      if (from === to || from < 0 || to < 0 || from >= d.length || to >= d.length) return d;
      const next = [...d];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });

  const confirmDelete = (agent: AcpAgent) =>
    requestConfirm({
      title: `Delete ${agent.name || "this agent"}?`,
      message: "It will no longer be offered by Draft, Improve or AI actions.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        setDraft((d) => d.filter((a) => a.id !== agent.id));
        setEditingId((cur) => (cur === agent.id ? null : cur));
      },
    });

  const connect = async (id: string) => {
    const agent = draft.find((a) => a.id === id);
    const repoPath = useRepo.getState().summary?.path;
    if (!agent?.command.trim() || !repoPath) return;
    await useAcpAgents.getState().probeAcp(agent.command, repoPath);
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveAgents(draft);
    } catch (e) {
      showToast(String(e instanceof Error ? e.message : e), "error");
    } finally {
      setSaving(false);
    }
  };

  const reset = () =>
    requestConfirm({
      title: "Reset AI agents?",
      message: "Your list is replaced by the agents GitLane detects on this machine.",
      confirmLabel: "Reset",
      danger: true,
      onConfirm: () => {
        setEditingId(null);
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
    dirty: signature(draft) !== signature(saved),
    valid: draft.every(isAiAgentValid),
    isEditing: (id) => editingId === id,
    startEdit: (id) => setEditingId(id),
    stopEdit: (id) => setEditingId((cur) => (cur === id ? null : cur)),
    update,
    addFromAdapter,
    addCustom,
    addAnother,
    confirmDelete,
    move,
    connect,
    save,
    reset,
  };
}
