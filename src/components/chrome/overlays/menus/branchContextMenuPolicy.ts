import { BranchKind, type BranchInfo, type WorktreeInfo } from "@/lib/api";
import { findOtherBranchWorktree, type WorktreeRef } from "@/lib/graphActions";
import {
  handoffDestinationHere,
  handoffDestinationOptions,
  handoffSourceValid,
} from "@/lib/worktreeHandoff";
import {
  remoteTrackingCheckoutCandidate,
  type RemoteCheckoutCandidate,
} from "@/lib/remoteBranches";

export const MAIN_WORKTREE_DELETE_DISABLED_REASON = "Checked out in the main worktree.";

export type LocalBranchDeleteMode = "none" | "branch" | "branch-and-worktree" | "blocked-main-worktree";

export interface RemoteBranchDeleteTarget {
  remote: string;
  branch: string;
}

export interface BranchContextMenuPolicy {
  info: BranchInfo | undefined;
  tip: string | null;
  tipShort: string | null;
  targetOid: string | null;
  currentOid: string | null;
  upstream: string | null;
  needsPublishPrompt: boolean;
  canIntegrateIntoCurrent: boolean;
  isLocal: boolean;
  isRemote: boolean;
  remoteCheckout: RemoteCheckoutCandidate | null;
  remoteCheckoutHasLocal: boolean;
  aheadBehind: string | null;
  existingWorktree: WorktreeRef | null;
  existingWorktreeInfo: WorktreeInfo | null;
  worktreeCheckedOut: boolean;
  worktreeRef: string;
  handoffHere: ReturnType<typeof handoffDestinationHere>;
  canHandOff: boolean;
  canRemoveWorktree: boolean;
  localDeleteMode: LocalBranchDeleteMode;
  remoteDeleteTarget: RemoteBranchDeleteTarget | null;
}

export interface BranchContextMenuPolicyInput {
  branch: string;
  isCurrent: boolean;
  currentBranch: string | null;
  branches: BranchInfo[];
  worktrees: WorktreeInfo[];
  workdir: string;
}

/** Pure ref resolution and eligibility policy for BranchContextMenu.
 *
 * The menu payload has only a display name, not a ref kind. A local/remote pair
 * with the same name is therefore deliberately unresolved so every action whose
 * safety depends on the selected ref's kind or oid fails closed together. */
export function deriveBranchContextMenuPolicy({
  branch,
  isCurrent,
  currentBranch,
  branches,
  worktrees,
  workdir,
}: BranchContextMenuPolicyInput): BranchContextMenuPolicy {
  const matches = branches.filter((candidate) => candidate.name === branch);
  const info = matches.length === 1 ? matches[0] : undefined;
  const tip = info?.target ?? null;
  const upstream = info?.upstream ?? null;
  const isLocal = info?.kind === BranchKind.Local;
  const isRemote = info?.kind === BranchKind.Remote;
  const remoteCheckout = remoteTrackingCheckoutCandidate(branch, branches);
  const remoteCheckoutHasLocal = remoteCheckout
    ? branches.some(
        (candidate) =>
          candidate.kind === BranchKind.Local && candidate.name === remoteCheckout.branch,
      )
    : false;
  const sync = info?.sync ?? null;
  const existingWorktree = findOtherBranchWorktree(worktrees, branch, workdir);
  const existingWorktreeInfo = existingWorktree
    ? worktrees.find((candidate) => candidate.path === existingWorktree.path) ?? null
    : null;
  const sourceValid = existingWorktree
    ? handoffSourceValid(worktrees, existingWorktree.path)
    : false;
  const handoffHere = existingWorktree && sourceValid && isLocal
    ? handoffDestinationHere(worktrees, existingWorktree.path, workdir)
    : null;
  const canHandOff = Boolean(
    isLocal &&
      !isCurrent &&
      existingWorktree &&
      sourceValid &&
      handoffDestinationOptions(worktrees, existingWorktree.path).length > 0,
  );
  const canRemoveWorktree = Boolean(existingWorktree && !existingWorktreeInfo?.isMain);
  const worktreeCheckedOut = isCurrent || worktrees.some((worktree) => worktree.branch === branch);

  let localDeleteMode: LocalBranchDeleteMode = "none";
  if (isLocal && !isCurrent) {
    localDeleteMode = existingWorktree
      ? existingWorktreeInfo?.isMain
        ? "blocked-main-worktree"
        : "branch-and-worktree"
      : "branch";
  }

  const remote = isRemote ? info?.remote ?? null : null;
  const remoteBranch = remote && branch.startsWith(`${remote}/`)
    ? branch.slice(remote.length + 1)
    : null;

  return {
    info,
    tip,
    tipShort: tip ? tip.slice(0, 7) : null,
    targetOid: tip,
    currentOid:
      branches.find(
        (candidate) =>
          candidate.kind === BranchKind.Local && candidate.name === currentBranch,
      )?.target ?? null,
    upstream,
    needsPublishPrompt:
      sync?.status === "noUpstream" || sync?.status === "staleUpstream",
    // `isCurrent` belongs to the menu-opening snapshot. The live branch can move
    // while that same menu object stays open, so also guard against self-actions.
    canIntegrateIntoCurrent: !isCurrent && currentBranch != null && branch !== currentBranch,
    isLocal,
    isRemote,
    remoteCheckout,
    remoteCheckoutHasLocal,
    aheadBehind: sync?.upstream ? `↑${sync.ahead} ↓${sync.behind}` : null,
    existingWorktree,
    existingWorktreeInfo,
    worktreeCheckedOut,
    worktreeRef: worktreeCheckedOut && tip ? tip : branch,
    handoffHere,
    canHandOff,
    canRemoveWorktree,
    localDeleteMode,
    remoteDeleteTarget:
      remote && remoteBranch && tip ? { remote, branch: remoteBranch } : null,
  };
}
