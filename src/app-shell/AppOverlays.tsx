import {
  ActionMenu,
  BranchContextMenu,
  CommitContextMenu,
  ConfirmDialog,
  CreateBranchDialog,
  FileContextMenu,
  HandoffDialog,
  PromptDialog,
  RepoGroupContextMenu,
  RepoTabContextMenu,
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
import { useUi } from "@/store/ui";
import { OverlayBoundary, type OverlayEntry } from "./OverlayBoundary";

const ui = () => useUi.getState();
const closeMenu = () => ui().closeOverlays();

/** Every globally-mounted overlay: modals, context menus, dialogs, toasts, and
 * the floating tooltip. Each is a self-contained singleton driven by its own
 * ui-store slice (rendering null while closed), so this file is a registry with
 * one axis of change — add an overlay here when it must be reachable from
 * anywhere in the app, together with the action that closes it. */
export const OVERLAYS: readonly OverlayEntry[] = [
  { id: "settings", Overlay: SettingsModal, close: () => ui().closeSettings() },
  { id: "repo-settings", Overlay: RepoSettingsModal, close: () => ui().closeRepoSettings() },
  { id: "action-menu", Overlay: ActionMenu, close: closeMenu },
  { id: "branch-menu", Overlay: BranchContextMenu, close: closeMenu },
  { id: "commit-menu", Overlay: CommitContextMenu, close: closeMenu },
  { id: "stash-menu", Overlay: StashContextMenu, close: closeMenu },
  { id: "file-menu", Overlay: FileContextMenu, close: closeMenu },
  { id: "wip-menu", Overlay: WipContextMenu, close: closeMenu },
  { id: "tag-menu", Overlay: TagContextMenu, close: closeMenu },
  { id: "worktree-menu", Overlay: WorktreeContextMenu, close: closeMenu },
  { id: "repo-tab-menu", Overlay: RepoTabContextMenu, close: closeMenu },
  { id: "repo-group-menu", Overlay: RepoGroupContextMenu, close: closeMenu },
  { id: "create-branch", Overlay: CreateBranchDialog, close: () => ui().setCreateBranchOpen(false) },
  { id: "create-pr", Overlay: CreatePrDialog, close: () => ui().closeCreatePr() },
  { id: "reflog-recovery", Overlay: ReflogRecoveryDialog, close: () => ui().closeRecovery() },
  { id: "agent-message", Overlay: AgentMessageDialog, close: () => ui().closeAgentMessage() },
  { id: "ai-actions", Overlay: AiActionsDialog, close: () => ui().closeAiActions() },
  { id: "confirm", Overlay: ConfirmDialog, close: () => ui().closeConfirm() },
  { id: "prompt", Overlay: PromptDialog, close: () => ui().closePrompt() },
  { id: "edit-commit-message", Overlay: EditCommitMessageDialog, close: () => ui().closeEditCommitMessage() },
  { id: "handoff", Overlay: HandoffDialog, close: () => ui().closeHandoff() },
  { id: "github-signin", Overlay: GithubSigninDialog, close: () => ui().closeGithubSignin() },
  { id: "provider-oauth", Overlay: ProviderOauthDialog, close: () => ui().closeProviderOauthSignin() },
  { id: "delete-worktree", Overlay: DeleteWorktreeDialog, close: () => ui().closeDeleteWorktree() },
  { id: "remove-detached", Overlay: RemoveDetachedDialog, close: () => ui().closeRemoveDetached() },
  // shortcut: a crashed toasts/tooltip layer stays empty until reload (no
  // resetKeys); add a store-driven reset if either ever crashes in practice.
  { id: "toasts", Overlay: Toasts, close: null },
  { id: "tooltip", Overlay: Tooltip, close: null },
];

/** Each overlay renders inside its own boundary, so one crashing dialog or menu
 * shows a closable error card instead of unmounting the whole window. */
export const AppOverlays = () => (
  <>
    {OVERLAYS.map((entry) => (
      <OverlayBoundary key={entry.id} entry={entry} />
    ))}
  </>
);
