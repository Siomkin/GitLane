import {
  ActionMenu,
  BranchContextMenu,
  CommitContextMenu,
  ConfirmDialog,
  CreateBranchDialog,
  FileContextMenu,
  HandoffDialog,
  PromptDialog,
  StashContextMenu,
  TagContextMenu,
  Toasts,
  Tooltip,
  WipContextMenu,
  WorktreeContextMenu,
} from "@/components/chrome/overlays";
import { DeleteWorktreeDialog } from "@/components/chrome/overlays/delete-worktree";
import { RemoveDetachedDialog } from "@/components/chrome/overlays/remove-detached";
import { GithubSigninDialog } from "@/components/chrome/overlays/github-signin";
import { ProviderOauthDialog } from "@/components/chrome/overlays/provider-oauth";
import { RepoSettingsModal } from "@/components/chrome/repo-settings";
import { SettingsModal } from "@/components/chrome/SettingsModal";
import { EditCommitMessageDialog } from "@/features/changes/commit-modal/EditCommitMessageDialog";
import { CreatePrDialog } from "@/features/pull-requests/create-pr";
import { ReflogRecoveryDialog } from "@/features/recovery";
import { AgentMessageDialog } from "@/features/review-notes/ReviewNotes";
import { AiActionsDialog } from "@/features/agents/ai-actions";

/** Every globally-mounted overlay: modals, context menus, dialogs, toasts, and
 * the floating tooltip. Each is a self-contained singleton driven by its own
 * ui-store slice (rendering null while closed), so this file is a registry with
 * one axis of change — add an overlay here when it must be reachable from
 * anywhere in the app. */
export const AppOverlays = () => (
  <>
    <SettingsModal />
    <RepoSettingsModal />
    <ActionMenu />
    <BranchContextMenu />
    <CommitContextMenu />
    <StashContextMenu />
    <FileContextMenu />
    <WipContextMenu />
    <TagContextMenu />
    <WorktreeContextMenu />
    <CreateBranchDialog />
    <CreatePrDialog />
    <ReflogRecoveryDialog />
    <AgentMessageDialog />
    <AiActionsDialog />
    <ConfirmDialog />
    <PromptDialog />
    <EditCommitMessageDialog />
    <HandoffDialog />
    <GithubSigninDialog />
    <ProviderOauthDialog />
    <DeleteWorktreeDialog />
    <RemoveDetachedDialog />
    <Toasts />
    <Tooltip />
  </>
);
