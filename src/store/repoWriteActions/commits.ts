// Committing: the plain commit, the staged-only commit, the message amend, and
// the two agent-draft hand-offs. Each pins the repo's bound identity so global
// git-config changes by other tools can never leak into a GitLane commit.

import { api } from "@/lib/api";
import { fileWriteGuard, findGuardedFile } from "@/lib/advancedRepoState";
import { splitCommitMessage } from "@/lib/commitMessage";
import { useAccounts } from "@/store/accounts";
import type { RepoGet, RepoSet, RepoState } from "@/store/repoTypes";
import {
  captureFileSelection,
  captureOwner,
  fileSelectionIsCurrent,
  refreshIfCurrent,
  runOp,
  toastAdvancedGuard,
  toastWriteError,
} from "./shared";

export function createCommitActions(
  set: RepoSet,
  get: RepoGet,
): Pick<
  RepoState,
  | "commit"
  | "amendHeadMessage"
  | "commitSelected"
  | "acpPrompt"
> {
  return {
    acpPrompt: async (agentCommand, repoPath, model, config, prompt, runId) =>
      api.acpPrompt(agentCommand, repoPath, model, config, prompt, runId),

    commit: async (summaryText, description, amend) => {
      const { summary } = get();
      if (!summary) return;
      const owner = captureOwner(summary);
      const fileSelection = captureFileSelection(get);
      // Pin the repo's bound identity (author + committer) so global-config
      // changes by other tools can never leak into a GitLane commit.
      const identity = useAccounts.getState().repoIdentity;
      try {
        await api.commit(
          summary.path,
          summary.headBranch,
          summary.headOid,
          summaryText,
          description,
          amend,
          identity?.name,
          identity?.email,
          identity,
        );
        if (
          await refreshIfCurrent(get, owner) &&
          fileSelectionIsCurrent(get, fileSelection)
        ) {
          set({ selectedFile: null, fileDiff: null });
        }
      } catch (e) {
        toastWriteError(get, e, () => get().commit(summaryText, description, amend));
      }
    },

    amendHeadMessage: (summaryText, description) =>
      runOp(get, async (summary) => {
        const identity = useAccounts.getState().repoIdentity;
        await api.commit(
          summary.path,
          summary.headBranch,
          summary.headOid,
          summaryText,
          description,
          true,
          identity?.name,
          identity?.email,
          identity,
        );
        return "Updated commit message";
      }),

    commitSelected: async (message, amend = false) => {
      const { summary } = get();
      if (!summary) return false;
      const owner = captureOwner(summary);
      const fileSelection = captureFileSelection(get);
      const { changes } = get();
      if (toastAdvancedGuard(fileWriteGuard(findGuardedFile(changes.staged, changes), changes))) {
        return false;
      }
      const identity = useAccounts.getState().repoIdentity;
      try {
        const { summary: subject, description } = splitCommitMessage(message);
        await api.commit(
          summary.path,
          summary.headBranch,
          summary.headOid,
          subject,
          description,
          amend,
          identity?.name,
          identity?.email,
          identity,
        );
        if (
          await refreshIfCurrent(get, owner) &&
          fileSelectionIsCurrent(get, fileSelection)
        ) {
          set({ selectedFile: null, fileDiff: null, wipSelected: false });
        }
        return true;
      } catch (e) {
        toastWriteError(get, e, async () => {
          await get().commitSelected(message, amend);
        });
        return false;
      }
    },
  };
}
