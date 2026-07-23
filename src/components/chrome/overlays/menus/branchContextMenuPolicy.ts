import { BranchKind, type BranchInfo, type RepoForge, type WorktreeInfo } from "@/lib/api";
import { branchWebUrl } from "@/lib/forgeUrls";
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
  /** Browser URL for this branch on its forge — non-null only on a recognised
   * forge for a *published* branch (an unpublished or stale-upstream branch would
   * 404). Drives the "View on <forge>" row. Mirrors the commit policy. */
  branchUrl: string | null;
  /** Human forge label for the "View on <forge>" row (e.g. "GitHub"). */
  forgeName: string | null;
}

export interface BranchContextMenuPolicyInput {
  branch: string;
  isCurrent: boolean;
  currentBranch: string | null;
  branches: BranchInfo[];
  worktrees: WorktreeInfo[];
  workdir: string;
  forge: RepoForge | null;
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
  forge,
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
  // Hand off is offered on a linked-worktree branch only when the source can
  // still run the detach step (bare/prunable worktrees filtered out) and a valid
  // destination exists. Local, non-current guards match the branch the fan shows on.
  const canHandOff = Boolean(
    isLocal &&
      !isCurrent &&
      existingWorktree &&
      sourceValid &&
      handoffDestinationOptions(worktrees, existingWorktree.path).length > 0,
  );
  // Git refuses to remove the main worktree, so Remove is offered for linked ones only.
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

  // Forge link. The forge branch name is the one that exists on the remote, NOT
  // the local ref: for a remote-tracking ref, drop the remote prefix; for a local
  // branch, use its upstream's branch (a local `feature-x` tracking `origin/main`
  // lives at `main` on the forge, never `feature-x`). A `.`-remote upstream
  // (tracking another local branch) has no forge page. A stale upstream means the
  // remote branch was deleted — the forge page would 404 — so hide the link.
  // Only a *recognised* forge (kind != null) yields a real URL; an unknown host
  // would fall back to the repo root. Mirrors the commit policy's gating.
  const upstreamRemote = info?.upstreamRemote ?? null;
  const localUpstreamBranch =
    upstreamRemote && upstreamRemote !== "." && upstream && upstream.startsWith(`${upstreamRemote}/`)
      ? upstream.slice(upstreamRemote.length + 1)
      : null;
  const forgeBranchName = isRemote ? remoteBranch : localUpstreamBranch;
  const upstreamStale = sync?.status === "staleUpstream";
  const knownForge = forge?.kind != null;
  const branchUrl =
    knownForge && forgeBranchName && !upstreamStale ? branchWebUrl(forge, forgeBranchName) : null;
  const forgeName = branchUrl ? forge?.forge ?? null : null;

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
    branchUrl,
    forgeName,
  };
}
