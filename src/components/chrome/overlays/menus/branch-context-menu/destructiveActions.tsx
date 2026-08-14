import { api } from "@/lib/api";
import { validateBranchName } from "@/lib/refName";
import { WarningIcon } from "@/components/ui/icons";
import { type MenuItem } from "@/components/chrome/overlays/shared";
import { previewConfirm } from "@/components/chrome/overlays/menus/previewConfirm";
import { resetSubmenu } from "@/components/chrome/overlays/menus/resetSubmenu";
import { MAIN_WORKTREE_DELETE_DISABLED_REASON } from "@/components/chrome/overlays/menus/branchContextMenuPolicy";
import type { BranchMenuContext } from "./context";

// ---- reset: a first-level, danger-toned submenu — kept at the same depth as
// the commit menu's Reset, never buried inside the Danger zone group. ----
export function resetItems(ctx: BranchMenuContext): MenuItem[] {
  const { b, cur, tip, isCurrent, headOid, repoPath, requestConfirm, run, resetBranchTo } = ctx;

  const resetHeadPrecondition = { branch: cur, oid: headOid };
  const reset: MenuItem[] =
    tip && cur && !isCurrent
      ? [{
          label: `Reset ${cur} to ${b}`,
          icon: <WarningIcon className="h-4 w-4" />,
          tone: "danger",
          submenu: resetSubmenu({
            title: `Reset ${cur} to ${b}?`,
            branch: cur,
            oid: tip,
            repoPath,
            requestConfirm,
            run,
            headPrecondition: resetHeadPrecondition,
            resetBranchTo,
          }),
        }]
      : [];
  return reset;
}

// ---- danger zone: the rarer branch-only destructive verbs (rename, force
// push, upstream, delete) — Reset lives above it, not inside. ----
export function dangerZoneItems(ctx: BranchMenuContext): MenuItem[] {
  const {
    b,
    tip,
    upstream,
    isCurrent,
    isLocal,
    repoPath,
    close,
    run,
    requestConfirm,
    requestPrompt,
    existingWorktree: existingWt,
    localDeleteMode,
    remoteDeleteTarget,
    openDeleteWorktree,
    renameBranchTo,
    forcePush,
    setUpstreamFor,
    removeBranch,
    deleteRemoteBranch,
  } = ctx;

  const danger: MenuItem[] = [];
  if (isLocal) {
    danger.push({ label: "Manage", header: true });
    danger.push({
      label: `Rename ${b}…`,
      onClick: () => requestPrompt({ title: `Rename branch ${b}`, placeholder: "new-branch-name", defaultValue: b, confirmLabel: "Rename", validate: validateBranchName, onSubmit: (next) => { if (next !== b) void run(() => renameBranchTo(b, next)); } }),
    });
    if (isCurrent) {
      danger.push({
        label: "Force push (with lease)…",
        onClick: () => void previewConfirm({ requestConfirm, title: `Force-push ${b}?`, message: "Overwrites the remote branch with your local history (--force-with-lease: aborts if the remote moved since this preview). Use after amending or rebasing pushed commits.", confirmLabel: "Force push", danger: true, preview: () => repoPath ? api.previewForcePush(repoPath, b) : Promise.reject(new Error("No repository")), onConfirm: (impact) => void run(() => forcePush(b, impact)) }),
      });
    }
  }
  if (isLocal) {
    // Set upstream is rare — tuck it down at the end, just above Delete.
    danger.push({
      label: upstream ? `Change upstream (${upstream})…` : "Set upstream…",
      onClick: () => requestPrompt({ title: `Set upstream for ${b}`, message: "Remote-tracking ref to track (must already exist).", placeholder: "origin/branch", defaultValue: upstream ?? `origin/${b}`, confirmLabel: "Set upstream", onSubmit: (up) => void run(() => setUpstreamFor(b, up)) }),
    });
    if (localDeleteMode === "branch-and-worktree" && existingWt) {
      danger.push({ label: `Delete ${b} & worktree…`, danger: true, onClick: () => { close(); openDeleteWorktree({ branch: b, worktreePath: existingWt.path }); } });
    } else if (localDeleteMode === "blocked-main-worktree") {
      danger.push({ label: `Delete ${b}`, disabled: true, disabledReason: MAIN_WORKTREE_DELETE_DISABLED_REASON });
    } else if (localDeleteMode === "branch") {
      danger.push({ label: `Delete ${b}`, danger: true, onClick: () => void previewConfirm({ requestConfirm, title: `Delete branch ${b}?`, message: "The branch ref will be removed. Unmerged commits may be lost.", confirmLabel: "Delete branch", danger: true, preview: () => repoPath ? api.previewDeleteBranch(repoPath, b) : Promise.reject(new Error("No repository")), onConfirm: (impact) => void run(() => removeBranch(b, impact.expectedOid, repoPath ?? "", true)) }) });
    }
  }
  if (remoteDeleteTarget && tip) {
    const { remote, branch: remoteBranch } = remoteDeleteTarget;
    danger.push({ label: `Delete ${b} on remote`, danger: true, onClick: () => void previewConfirm({ requestConfirm, title: `Delete ${remoteBranch} on ${remote}?`, message: `The branch will be deleted on the remote (${remote}). This affects everyone using it and can't be undone here.`, confirmLabel: "Delete on remote", danger: true, preview: () => repoPath ? api.previewDeleteRemoteBranch(repoPath, remote, remoteBranch) : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => deleteRemoteBranch(remote, remoteBranch, tip)) }) });
  }
  return danger;
}
