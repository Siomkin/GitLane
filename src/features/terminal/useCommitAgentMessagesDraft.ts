import { useEffect, useRef, useState } from "react";
import type { AiActionCommand, CommitAgentMessages } from "@/lib/api";
import {
  DEFAULT_COMMIT_AGENT_MESSAGES,
  useCommitAgentMessages,
} from "@/store/commitAgentMessages";
import { useUi } from "@/store/ui";
import {
  blankAiActionCommand,
  isBuiltinAiAction,
  moveAiActionCommand,
  persistableAiActions,
  removeAiActionCommand,
  resetBuiltinAiAction,
  updateAiActionCommand,
} from "@/features/agents/ai-actions/aiActionDraft";

export const COMMIT_PROMPT_ID = "commit";

const signature = (messages: CommitAgentMessages) =>
  JSON.stringify([
    messages.draftInstruction,
    messages.commitInstruction,
    messages.descriptionInstruction,
    messages.aiActions,
  ]);

function persistable(
  messages: CommitAgentMessages,
  saved: CommitAgentMessages,
  editingIds: ReadonlySet<string>,
): CommitAgentMessages | null {
  // An in-progress edit of the shared prompt is not persisted until Save, so
  // that row falls back to what is on disk.
  const source = editingIds.has(COMMIT_PROMPT_ID) ? saved : messages;
  const draftInstruction = source.draftInstruction.trim();
  // Never derived from `draftInstruction` here: `update` and `resetField`
  // already move the two together when the user edits the shared field, so
  // rewriting it on every save would only ever clobber a value the user did
  // not touch. Loading folds a legacy divergent prompt in once.
  const commitInstruction = source.commitInstruction.trim() || draftInstruction;
  const descriptionInstruction = messages.descriptionInstruction.trim();
  if (!draftInstruction || !descriptionInstruction) return null;
  const aiActions = persistableAiActions(
    messages.aiActions.flatMap((command) => {
      if (!editingIds.has(command.id)) return [command];
      const fromSaved = saved.aiActions.find((row) => row.id === command.id);
      if (!fromSaved) return [];
      return [{ ...fromSaved, enabled: command.enabled }];
    }),
  );
  return {
    draftInstruction,
    commitInstruction,
    descriptionInstruction,
    aiActions,
  };
}

export function useCommitAgentMessagesDraft() {
  const saved = useCommitAgentMessages((state) => state.messages);
  const loading = useCommitAgentMessages((state) => state.loading);
  const error = useCommitAgentMessages((state) => state.error);
  const loadMessages = useCommitAgentMessages((state) => state.loadMessages);
  const saveMessages = useCommitAgentMessages((state) => state.saveMessages);
  const showToast = useUi((state) => state.showToast);
  const requestConfirm = useUi((state) => state.requestConfirm);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [editingIds, setEditingIds] = useState<Set<string>>(() => new Set());
  const syncedSignature = useRef(signature(saved));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const editingIdsRef = useRef(editingIds);
  editingIdsRef.current = editingIds;
  const savingRef = useRef(false);
  const persistAgain = useRef(false);
  const persistAgainSaveId = useRef<string | null>(null);
  const persistNowRef = useRef<(saveId?: string) => Promise<boolean>>(async () => true);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    const previous = syncedSignature.current;
    setDraft((current) => (signature(current) === previous ? saved : current));
    syncedSignature.current = signature(saved);
  }, [saved]);

  /** Write the draft to disk. `saveId` is the one row whose in-progress edit is
   *  being saved — every *other* open editor still falls back to what is on
   *  disk, so saving one row cannot commit a half-typed prompt in another.
   *  Resolves false when nothing was written and the caller should keep its
   *  editor open: a rejected write, or a draft that fails validation. */
  const persistNow = async (saveId?: string): Promise<boolean> => {
    const editing = new Set(editingIdsRef.current);
    if (saveId) editing.delete(saveId);
    const next = persistable(draftRef.current, savedRef.current, editing);
    if (!next) return false;
    if (signature(next) === signature(savedRef.current)) return true;
    if (savingRef.current) {
      // Coalesced behind an in-flight write; that run carries this row's id and
      // does the work, so the editor may close.
      persistAgain.current = true;
      persistAgainSaveId.current ??= saveId ?? null;
      return true;
    }
    savingRef.current = true;
    setSaving(true);
    let ok = true;
    try {
      await saveMessages(next);
      syncedSignature.current = signature(next);
    } catch (saveError) {
      ok = false;
      showToast(String(saveError instanceof Error ? saveError.message : saveError), "error");
    } finally {
      savingRef.current = false;
      setSaving(false);
      if (persistAgain.current) {
        persistAgain.current = false;
        const again = persistAgainSaveId.current ?? undefined;
        persistAgainSaveId.current = null;
        void persistNowRef.current(again);
      }
    }
    return ok;
  };
  persistNowRef.current = persistNow;

  useEffect(() => () => void persistNowRef.current(), []);

  const apply = (updater: (current: CommitAgentMessages) => CommitAgentMessages): CommitAgentMessages => {
    const next = updater(draftRef.current);
    draftRef.current = next;
    setDraft(next);
    return next;
  };

  const isEditing = (id: string) => editingIds.has(id);
  const startEdit = (id: string) =>
    setEditingIds((ids) => (ids.has(id) ? ids : new Set(ids).add(id)));
  const stopEdit = (id: string) =>
    setEditingIds((ids) => {
      if (!ids.has(id)) return ids;
      const next = new Set(ids);
      next.delete(id);
      return next;
    });

  const update = (value: string) => {
    apply((current) => ({ ...current, draftInstruction: value, commitInstruction: value }));
  };

  const resetField = () => {
    apply((current) => ({
      ...current,
      draftInstruction: DEFAULT_COMMIT_AGENT_MESSAGES.draftInstruction,
      commitInstruction: DEFAULT_COMMIT_AGENT_MESSAGES.commitInstruction,
    }));
  };

  const patchCommand = (id: string, patch: Partial<AiActionCommand>, immediate = false) => {
    apply((current) => ({
      ...current,
      aiActions: updateAiActionCommand(current.aiActions, id, patch),
    }));
    if (immediate) void persistNow();
  };

  const addCommand = () => {
    const row = blankAiActionCommand();
    apply((current) => ({ ...current, aiActions: [...current.aiActions, row] }));
    startEdit(row.id);
  };

  const moveCommand = (from: number, to: number) => {
    apply((current) => ({
      ...current,
      aiActions: moveAiActionCommand(current.aiActions, from, to),
    }));
  };

  const resetCommand = (id: string) => {
    apply((current) => ({
      ...current,
      aiActions: resetBuiltinAiAction(current.aiActions, id),
    }));
  };

  const confirmReset = (id: string) => {
    const label =
      id === COMMIT_PROMPT_ID
        ? "Commit message"
        : (draftRef.current.aiActions.find((row) => row.id === id)?.title.trim() || "this command");
    requestConfirm({
      title: "Reset to default?",
      message: `Replace the “${label}” prompt with the shipped text? It stays in the editor until you Save.`,
      confirmLabel: "Reset",
      onConfirm: () => {
        if (id === COMMIT_PROMPT_ID) resetField();
        else resetCommand(id);
      },
    });
  };

  const isDirty = (id: string) => {
    if (id === COMMIT_PROMPT_ID) {
      return draft.draftInstruction !== saved.draftInstruction;
    }
    const current = draft.aiActions.find((row) => row.id === id);
    if (!current) return false;
    const fromSaved = saved.aiActions.find((row) => row.id === id);
    if (!fromSaved) return current.title.trim() !== "" || current.instruction.trim() !== "";
    return current.title !== fromSaved.title || current.instruction !== fromSaved.instruction;
  };

  const atShippedDefault = (id: string) => {
    if (id === COMMIT_PROMPT_ID) {
      return draft.draftInstruction === DEFAULT_COMMIT_AGENT_MESSAGES.draftInstruction;
    }
    const current = draft.aiActions.find((row) => row.id === id);
    const shipped = DEFAULT_COMMIT_AGENT_MESSAGES.aiActions.find((row) => row.id === id);
    return (
      !!current &&
      !!shipped &&
      current.title === shipped.title &&
      current.instruction === shipped.instruction
    );
  };

  const confirmDelete = (command: AiActionCommand) => {
    if (isBuiltinAiAction(command.id)) return;
    requestConfirm({
      title: "Delete command?",
      message: `“${command.title.trim() || "Untitled command"}” will be removed from the AI actions list.`,
      confirmLabel: "Delete command",
      danger: true,
      onConfirm: () => {
        apply((current) => ({
          ...current,
          aiActions: removeAiActionCommand(current.aiActions, command.id),
        }));
        stopEdit(command.id);
        void persistNowRef.current();
      },
    });
  };

  const saveEdit = (id: string) => {
    // Collapse only once the write actually landed — a failed save that closed
    // the editor would present the unsaved text as saved.
    void persistNow(id).then((ok) => {
      if (ok) stopEdit(id);
    });
  };

  const cancelEdit = (id: string) => {
    if (id === COMMIT_PROMPT_ID) {
      apply((current) => ({
        ...current,
        draftInstruction: savedRef.current.draftInstruction,
        commitInstruction: savedRef.current.commitInstruction,
      }));
    } else {
      const fromSaved = savedRef.current.aiActions.find((row) => row.id === id);
      if (!fromSaved) {
        apply((current) => ({
          ...current,
          aiActions: removeAiActionCommand(current.aiActions, id),
        }));
      } else {
        apply((current) => ({
          ...current,
          aiActions: updateAiActionCommand(current.aiActions, id, {
            title: fromSaved.title,
            instruction: fromSaved.instruction,
          }),
        }));
      }
    }
    stopEdit(id);
  };

  return {
    draft,
    loading,
    error,
    saving,
    isEditing,
    startEdit,
    saveEdit,
    cancelEdit,
    persistNow,
    update,
    confirmReset,
    isDirty,
    atShippedDefault,
    patchCommand,
    addCommand,
    moveCommand,
    confirmDelete,
  };
}
