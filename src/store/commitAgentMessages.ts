// Shared cache for the user-editable instructions used by terminal-agent
// actions. Durability belongs to the Rust app-data config; the
// defaults here keep the actions usable before the first backend load settles.

import { create } from "zustand";
import { api, type CommitAgentMessages } from "@/lib/api";
import { requestLease } from "./requestLease";

/** Must stay byte-identical to the Rust defaults in `terminal_agents.rs`: the
 *  backend migrates a saved config off its own previous defaults by exact match,
 *  so a copy that drifts here would show the user text the backend never
 *  recognises. */
export const DEFAULT_COMMIT_AGENT_MESSAGES: CommitAgentMessages = {
  draftInstruction:
    "Read the staged diff once (`git diff --staged`) and write a conventional commit message. Do not open files, run tests, or search the codebase — the diff is the only evidence. Subject under 72 characters. Add a body explaining what changed and why, wrapped at 72 columns, unless the change is small enough that the subject already says everything. Reply with the commit message and nothing else.",
  commitInstruction:
    "Read the staged diff once (`git diff --staged`), write a conventional commit message, and commit. Do not open files, run tests, or search the codebase — the diff is the only evidence. Subject under 72 characters. Add a body explaining what changed and why, wrapped at 72 columns, unless the change is small enough that the subject already says everything.",
  descriptionInstruction:
    "Summarize what the changes do and why, in at most 4 sentences or 5 short bullets. Read the diff only — do not open other files, run tests, or search the codebase. This is a quick summary, not a code review: no quality findings, no risk analysis, no file-by-file inventory. Be fast.",
};

interface CommitAgentMessagesState {
  messages: CommitAgentMessages;
  loading: boolean;
  error: string | null;
  loadMessages: () => Promise<void>;
  saveMessages: (messages: CommitAgentMessages) => Promise<void>;
  resetMessages: () => Promise<void>;
}

// Overlapping load/save/reset settle newest-wins — a save landing after a reset
// must not republish what the reset just replaced.
const writes = requestLease();
let loadInFlight = false;

function isCommitAgentMessages(value: unknown): value is CommitAgentMessages {
  if (!value || typeof value !== "object") return false;
  const messages = value as Partial<CommitAgentMessages>;
  return (
    typeof messages.draftInstruction === "string" &&
    typeof messages.commitInstruction === "string" &&
    typeof messages.descriptionInstruction === "string"
  );
}

export const useCommitAgentMessages = create<CommitAgentMessagesState>((set) => ({
  messages: DEFAULT_COMMIT_AGENT_MESSAGES,
  loading: false,
  error: null,

  loadMessages: async () => {
    if (loadInFlight) return;
    loadInFlight = true;
    const token = writes.claim();
    set({ loading: true });
    try {
      const messages = await api.commitAgentMessagesGet();
      if (!isCommitAgentMessages(messages)) {
        throw new Error("Could not load commit agent messages.");
      }
      if (writes.isCurrent(token)) set({ messages, error: null });
    } catch (error) {
      if (writes.isCurrent(token)) {
        set({ error: String(error instanceof Error ? error.message : error) });
      }
    } finally {
      loadInFlight = false;
      if (writes.isCurrent(token)) set({ loading: false });
    }
  },

  saveMessages: async (messages) => {
    const token = writes.claim();
    try {
      await api.commitAgentMessagesSet(messages);
      if (writes.isCurrent(token)) set({ messages, error: null, loading: false });
    } catch (error) {
      if (writes.isCurrent(token)) set({ loading: false });
      throw error;
    }
  },

  resetMessages: async () => {
    const token = writes.claim();
    try {
      const messages = await api.commitAgentMessagesReset();
      if (!isCommitAgentMessages(messages)) {
        throw new Error("Could not reset commit agent messages.");
      }
      if (writes.isCurrent(token)) set({ messages, error: null, loading: false });
    } catch (error) {
      if (writes.isCurrent(token)) set({ loading: false });
      throw error;
    }
  },
}));
