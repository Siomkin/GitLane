import { useEffect, useRef, useState } from "react";
import type { CommitAgentMessages } from "@/lib/api";
import {
  DEFAULT_COMMIT_AGENT_MESSAGES,
  useCommitAgentMessages,
} from "@/store/commitAgentMessages";
import { useUi } from "@/store/ui";

const signature = (messages: CommitAgentMessages) =>
  JSON.stringify([messages.draftInstruction, messages.commitInstruction]);

export function useCommitAgentMessagesDraft() {
  const saved = useCommitAgentMessages((state) => state.messages);
  const loading = useCommitAgentMessages((state) => state.loading);
  const error = useCommitAgentMessages((state) => state.error);
  const loadMessages = useCommitAgentMessages((state) => state.loadMessages);
  const saveMessages = useCommitAgentMessages((state) => state.saveMessages);
  const showToast = useUi((state) => state.showToast);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const syncedSignature = useRef(signature(saved));

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    const previous = syncedSignature.current;
    setDraft((current) => (signature(current) === previous ? saved : current));
    syncedSignature.current = signature(saved);
  }, [saved]);

  const dirty = signature(draft) !== signature(saved);
  const valid = Boolean(draft.draftInstruction.trim() && draft.commitInstruction.trim());

  const update = (field: keyof CommitAgentMessages, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const resetField = (field: keyof CommitAgentMessages) => {
    setDraft((current) => ({ ...current, [field]: DEFAULT_COMMIT_AGENT_MESSAGES[field] }));
  };

  const save = async () => {
    if (!dirty || !valid) return;
    setSaving(true);
    try {
      const normalized = {
        draftInstruction: draft.draftInstruction.trim(),
        commitInstruction: draft.commitInstruction.trim(),
      };
      await saveMessages(normalized);
      setDraft(normalized);
      syncedSignature.current = signature(normalized);
      showToast("Saved commit agent messages");
    } catch (saveError) {
      showToast(String(saveError instanceof Error ? saveError.message : saveError), "error");
    } finally {
      setSaving(false);
    }
  };

  return { draft, loading, error, saving, dirty, valid, update, resetField, save };
}
