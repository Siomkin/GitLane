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

/** All context menus share the one `menu` slot. */
const menu = (id: string, Overlay: OverlayEntry["Overlay"]): OverlayEntry => ({
  id,
  Overlay,
  close: () => ui().closeOverlays(),
  isOpen: (s) => s.menu !== null,
});

/** Every globally-mounted overlay: modals, context menus, dialogs, toasts, and
 * the floating tooltip. Each is a self-contained singleton driven by its own
 * ui-store slice (rendering null while closed), so this file is a registry with
 * one axis of change — add an overlay here when it must be reachable from
 * anywhere in the app, together with the flag that keeps it open and the
 * action that closes it. */
export const OVERLAYS: readonly OverlayEntry[] = [
  { id: "settings", Overlay: SettingsModal, close: () => ui().closeSettings(), isOpen: (s) => s.settingsOpen },
  {
    id: "repo-settings",
    Overlay: RepoSettingsModal,
    close: () => ui().closeRepoSettings(),
    isOpen: (s) => s.repoSettingsOpen,
  },
  menu("action-menu", ActionMenu),
  menu("branch-menu", BranchContextMenu),
  menu("commit-menu", CommitContextMenu),
  menu("stash-menu", StashContextMenu),
  menu("file-menu", FileContextMenu),
  menu("wip-menu", WipContextMenu),
  menu("tag-menu", TagContextMenu),
  menu("worktree-menu", WorktreeContextMenu),
  menu("repo-tab-menu", RepoTabContextMenu),
  menu("repo-group-menu", RepoGroupContextMenu),
  {
    id: "create-branch",
    Overlay: CreateBranchDialog,
    close: () => ui().setCreateBranchOpen(false),
    isOpen: (s) => s.createBranchOpen,
  },
  { id: "create-pr", Overlay: CreatePrDialog, close: () => ui().closeCreatePr(), isOpen: (s) => s.createPrOpen },
  {
    id: "reflog-recovery",
    Overlay: ReflogRecoveryDialog,
    close: () => ui().closeRecovery(),
    isOpen: (s) => s.recoveryOpen,
  },
  {
    id: "agent-message",
    Overlay: AgentMessageDialog,
    close: () => ui().closeAgentMessage(),
    isOpen: (s) => s.agentMessageOpen,
  },
  {
    id: "ai-actions",
    Overlay: AiActionsDialog,
    close: () => ui().closeAiActions(),
    isOpen: (s) => s.aiActions !== null,
  },
  { id: "confirm", Overlay: ConfirmDialog, close: () => ui().closeConfirm(), isOpen: (s) => s.confirm !== null },
  { id: "prompt", Overlay: PromptDialog, close: () => ui().closePrompt(), isOpen: (s) => s.prompt !== null },
  {
    id: "edit-commit-message",
    Overlay: EditCommitMessageDialog,
    close: () => ui().closeEditCommitMessage(),
    isOpen: (s) => s.editCommitMessage !== null,
  },
  { id: "handoff", Overlay: HandoffDialog, close: () => ui().closeHandoff(), isOpen: (s) => s.handoff !== null },
  {
    id: "github-signin",
    Overlay: GithubSigninDialog,
    close: () => ui().closeGithubSignin(),
    isOpen: (s) => s.githubSignin !== null,
  },
  {
    id: "provider-oauth",
    Overlay: ProviderOauthDialog,
    close: () => ui().closeProviderOauthSignin(),
    isOpen: (s) => s.providerOauthSignin !== null,
  },
  {
    id: "delete-worktree",
    Overlay: DeleteWorktreeDialog,
    close: () => ui().closeDeleteWorktree(),
    isOpen: (s) => s.deleteWorktree !== null,
  },
  {
    id: "remove-detached",
    Overlay: RemoveDetachedDialog,
    close: () => ui().closeRemoveDetached(),
    isOpen: (s) => s.removeDetached !== null,
  },
  // shortcut: a crashed toasts/tooltip layer stays empty until reload (no open
  // flag to reset on); add a store-driven reset if either ever crashes in practice.
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
