// Shared cache for the user-editable instructions used by terminal-agent
// actions. Durability belongs to the Rust app-data config; the
// defaults here keep the actions usable before the first backend load settles.

import { create } from "zustand";
import { api, type AiActionCommand, type CommitAgentMessages } from "@/lib/api";
import { requestLease } from "./requestLease";

/** Must stay byte-identical to the Rust defaults in `terminal_agents/defaults.rs`: the
 *  backend migrates a saved config off its own previous defaults by exact match,
 *  so a copy that drifts here would show the user text the backend never
 *  recognises. */
const AI_ACTION = (
  id: string,
  title: string,
  instruction: string,
): AiActionCommand => ({ id, title, instruction, enabled: true });

export const DEFAULT_COMMIT_AGENT_MESSAGES: CommitAgentMessages = {
  draftInstruction:
    "Read the staged diff once (`git diff --staged`) and write a conventional commit message. Do not open files, run tests, or search the codebase — the diff is the only evidence. Subject under 72 characters. Add a body explaining what changed and why, wrapped at 72 columns, unless the change is small enough that the subject already says everything.",
  commitInstruction:
    "Read the staged diff once (`git diff --staged`) and write a conventional commit message. Do not open files, run tests, or search the codebase — the diff is the only evidence. Subject under 72 characters. Add a body explaining what changed and why, wrapped at 72 columns, unless the change is small enough that the subject already says everything.",
  descriptionInstruction:
    "Summarize what the changes do and why, in at most 4 sentences or 5 short bullets. Read the diff only — do not open other files, run tests, or search the codebase. This is a quick summary, not a code review: no quality findings, no risk analysis, no file-by-file inventory. Be fast.",
  aiActions: [
    AI_ACTION(
      "short",
      "Short description",
      "Write a concise summary of what changed and why it matters, in at most 4 sentences or 5 short bullets. Use Markdown — a short paragraph, or a bullet list when that is clearer. Include enough detail to understand the main behavior and important effects. No preamble or file-by-file inventory. Reply with the Markdown and nothing else.",
    ),
    AI_ACTION(
      "full",
      "Full description",
      "Write a clear Markdown description of what changed, why it was needed, and how the main pieces work together. Use short headings and bullets where they help scanning. Include user-visible behavior, important implementation choices, and relevant limitations or trade-offs when supported by the diff. Use enough detail to make the change understandable without turning it into a file-by-file inventory. Reply with the Markdown and nothing else.",
    ),
    AI_ACTION(
      "impl",
      "Implementation comment",
      "Write a practical implementation update for developers, product, and QA as Markdown. Use short headings and bullets. Explain the problem, the solution, and any behavior or contract impact. Include validation evidence, QA actions with expected results, real risks, and follow-ups only when relevant. Omit empty sections and file-by-file inventories, and do not claim tests ran unless the evidence says so. Reply with the Markdown and nothing else.",
    ),
    AI_ACTION(
      "release",
      "Release notes",
      "Write release-note entries for people who use the product as Markdown bullets. Explain every meaningful user-visible outcome and why it is useful in plain language, without implementation details. Omit refactors, tests, and other internal-only work. If there is no user-visible change, say so plainly. Reply with the Markdown and nothing else.",
    ),
    AI_ACTION(
      "review",
      "Review & risk",
      "Review the diff for concrete defects that could break behavior, lose data, weaken security, or cause regressions. Report only actionable findings supported by the diff, highest impact first, as a Markdown list. For each finding, name the affected area, explain the failure scenario, and suggest the smallest fix. Skip summaries, praise, style preferences, speculative concerns, and low-risk observations. Reply with the Markdown and nothing else; if there are none, reply exactly: No actionable findings.",
    ),
    AI_ACTION(
      "test",
      "Test plan",
      "Write a focused numbered Markdown test plan for the behavior affected by this change. Cover the main path plus edge cases and regressions that are relevant to the diff, not generic checks. Each step must say what to do and what result to expect. Include setup only when needed, and do not invent UI paths, data, or prerequisites. Reply with the Markdown and nothing else.",
    ),
  ],
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

function isAiActionCommand(value: unknown): value is AiActionCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Partial<AiActionCommand>;
  return (
    typeof command.id === "string" &&
    typeof command.title === "string" &&
    typeof command.instruction === "string" &&
    typeof command.enabled === "boolean"
  );
}

function isAiActionCommands(value: unknown): value is AiActionCommand[] {
  return Array.isArray(value) && value.every(isAiActionCommand);
}

function isCommitAgentMessages(value: unknown): value is CommitAgentMessages {
  if (!value || typeof value !== "object") return false;
  const messages = value as Partial<CommitAgentMessages>;
  return (
    typeof messages.draftInstruction === "string" &&
    typeof messages.commitInstruction === "string" &&
    typeof messages.descriptionInstruction === "string" &&
    isAiActionCommands(messages.aiActions)
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
