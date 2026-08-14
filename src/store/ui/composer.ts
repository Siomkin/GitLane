// The inline commit composer in the Working Changes inspector, including the
// agent draft handed to it.

import type { AcpAgent } from "@/lib/api";
import { ComposerMode } from "@/lib/conventionalCommit";
import { useRepo } from "@/store/repo";
import type { SliceSet } from "./slice";
import { persistedKeys } from "./slice";
import type { ToastSlice } from "./toasts";

/** An in-flight agent commit-message draft. Scoped to the repository that
 * launched it so a late answer can never land in another repo's composer. */
export interface AgentCommitDraftRequest {
  token: string;
  agentName: string;
  repoPath: string;
  startedAt: number;
}

export interface ComposerSlice {
  /** Draft message shown by the inline composer in the Working Changes inspector. */
  commitMsg: string;
  /** The composer's message style — free-form or structured conventional
   * commit. A view preference, so it persists. */
  commitComposerMode: ComposerMode;
  /** Id of the terminal agent last used to draft a commit message, shown as the
   * active choice in the composer's Draft menu. Persists across sessions. */
  commitDraftAgent: string | null;
  /** Pending terminal-agent draft handoff. Session-only and repo-scoped. */
  agentCommitDraft: AgentCommitDraftRequest | null;

  /** Hand commit-message drafting to an AI agent and land its answer in the
   *  composer. */
  startAgentCommitDraft: (
    request: AgentCommitDraftRequest,
    instruction: string,
    agent: AcpAgent,
  ) => void;
  cancelAgentCommitDraft: () => void;
  setCommitMsg: (msg: string) => void;
  setCommitComposerMode: (mode: ComposerMode) => void;
  setCommitDraftAgent: (agentId: string | null) => void;
}

/** The inline commit composer. The draft belongs to the working tree that is no
 * longer on screen; an in-flight agent draft is abandoned with it. */
export const resetCommitComposer = () =>
  ({ commitMsg: "", agentCommitDraft: null }) satisfies Partial<ComposerSlice>;

export const persistedComposer = (s: ComposerSlice) =>
  persistedKeys(s, ["commitComposerMode", "commitDraftAgent"]);

export function createComposerSlice(
  set: SliceSet<ComposerSlice>,
  get: () => ComposerSlice & Pick<ToastSlice, "showToast">,
): ComposerSlice {
  return {
    ...resetCommitComposer(),
    commitComposerMode: ComposerMode.Conventional,
    commitDraftAgent: null,

    startAgentCommitDraft: (request, instruction, agent) => {
      set({ agentCommitDraft: request });
      void useRepo
        .getState()
        .acpPrompt(
          agent.command,
          request.repoPath,
          agent.model,
          agent.config,
          instruction,
          request.token,
        )
        .then((draft) => {
          // A newer request (or a cancel) supersedes this one.
          if (get().agentCommitDraft?.token !== request.token) return;
          const trimmed = draft.trim();
          if (!trimmed) {
            set({ agentCommitDraft: null });
            get().showToast("The agent returned an empty commit-message draft.", "error");
            return;
          }
          set({ agentCommitDraft: null, commitMsg: trimmed });
        })
        .catch((error: unknown) => {
          if (get().agentCommitDraft?.token !== request.token) return;
          set({ agentCommitDraft: null });
          get().showToast(
            `Could not collect the agent's commit-message draft: ${String(error)}`,
            "error",
          );
        });
    },
    cancelAgentCommitDraft: () => {
      // Clearing the banner used to leave the adapter running for up to five
      // minutes — invisible, still able to call tools. Stop has to reach it.
      const running = get().agentCommitDraft;
      set({ agentCommitDraft: null });
      if (running) void useRepo.getState().acpCancel(running.token).catch(() => {});
    },
    setCommitMsg: (msg) => set({ commitMsg: msg }),
    setCommitComposerMode: (mode) => set({ commitComposerMode: mode }),
    setCommitDraftAgent: (agentId) => set({ commitDraftAgent: agentId }),
  };
}
