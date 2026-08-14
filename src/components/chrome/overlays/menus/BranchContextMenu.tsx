import { ForgeKind } from "@/lib/api";
import { openExternalUrl } from "@/lib/openExternal";
import {
  BranchIcon,
  CopyIcon,
  ExternalLinkIcon,
  HashIcon,
  TreeIcon,
  WarningIcon,
} from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useUi, contextMenuOf } from "@/store/ui";
import { MenuPanel, useBranchOp, type MenuItem } from "@/components/chrome/overlays/shared";
import { deriveBranchContextMenuPolicy } from "./branchContextMenuPolicy";
import { useBranchFastForwardProbe } from "./useBranchFastForwardProbe";
import { useRemoveWorktree } from "./useRemoveWorktree";
import { menuAction } from "./menuAction";
import type { BranchMenuContext } from "./branch-context-menu/context";
import { quickActionItems } from "./branch-context-menu/quickActions";
import { integrateItems } from "./branch-context-menu/integrateActions";
import { createItems } from "./branch-context-menu/createActions";
import { worktreeItems } from "./branch-context-menu/worktreeActions";
import { dangerZoneItems, resetItems } from "./branch-context-menu/destructiveActions";

export function BranchContextMenu() {
  const menu = useUi(contextMenuOf);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const requestPrompt = useUi((s) => s.requestPrompt);
  const openHandoff = useUi((s) => s.openHandoff);
  const openDeleteWorktree = useUi((s) => s.openDeleteWorktree);
  const showToast = useUi((s) => s.showToast);
  const openCreateBranchFrom = useUi((s) => s.openCreateBranchFrom);
  const openCreatePr = useUi((s) => s.openCreatePr);
  const openCompare = useRepo((s) => s.openCompare);
  const forge = useRepo((s) => s.forge);
  // A forge we haven't identified yet counts as capable, matching the PR
  // list's own gate — otherwise the item would flicker away on a slow detect.
  const prsUnsupported =
    forge != null &&
    forge.kind !== ForgeKind.GitHub &&
    forge.kind !== ForgeKind.GitLab &&
    forge.kind !== ForgeKind.Bitbucket;
  const createPatchAt = useRepo((s) => s.createPatchAt);
  const repoPath = useRepo((s) => s.summary?.path ?? null);
  const workdir = useRepo((s) => s.summary?.workdir ?? s.summary?.path ?? "");
  const cur = useRepo((s) => s.summary?.headBranch ?? null);
  const headOid = useRepo((s) => s.summary?.headOid ?? null);
  const branches = useRepo((s) => s.branches);
  const worktrees = useRepo((s) => s.worktrees);
  const checkoutBranch = useRepo((s) => s.checkoutBranch);
  const checkoutRemoteBranch = useRepo((s) => s.checkoutRemoteBranch);
  const removeBranch = useRepo((s) => s.removeBranch);
  const renameBranchTo = useRepo((s) => s.renameBranchTo);
  const setUpstreamFor = useRepo((s) => s.setUpstreamFor);
  const pushBranch = useRepo((s) => s.pushBranch);
  const publishBranch = useRepo((s) => s.publishBranch);
  const pull = useRepo((s) => s.pull);
  const push = useRepo((s) => s.push);
  const forcePush = useRepo((s) => s.forcePush);
  const deleteRemoteBranch = useRepo((s) => s.deleteRemoteBranch);
  const mergeInto = useRepo((s) => s.mergeInto);
  const rebaseOnto = useRepo((s) => s.rebaseOnto);
  const fastForwardTo = useRepo((s) => s.fastForwardTo);
  const resetBranchTo = useRepo((s) => s.resetBranchTo);
  const cherryPickCommit = useRepo((s) => s.cherryPickCommit);
  const revertCommit = useRepo((s) => s.revertCommit);
  const createTagAt = useRepo((s) => s.createTagAt);
  const createAnnotatedTagAt = useRepo((s) => s.createAnnotatedTagAt);
  const createWorktreeAt = useRepo((s) => s.createWorktreeAt);
  const openWorktree = useRepo((s) => s.openWorktree);
  const requestRemoveWorktree = useRemoveWorktree();
  const run = useBranchOp();

  const policy = menu
    ? deriveBranchContextMenuPolicy({
        branch: menu.branch,
        isCurrent: menu.isCurrent,
        currentBranch: cur,
        branches,
        worktrees,
        workdir,
        forge,
      })
    : null;
  // Can the current branch fast-forward to this one? The hook keys the answer to
  // this exact menu opening, repository, and oid pair so delayed reads fail closed.
  const canFf = useBranchFastForwardProbe({
    owner: menu,
    repoPath,
    targetOid: policy?.targetOid ?? null,
    currentOid: policy?.currentOid ?? null,
    enabled: policy?.canIntegrateIntoCurrent ?? false,
  });

  if (!menu || !policy) return null;

  const { isCurrent } = menu;
  const b = menu.branch;
  const { tip, existingWorktree: existingWt, aheadBehind, branchUrl, forgeName } = policy;

  const act = menuAction(close, run);

  // One resolved context for the row builders below: the pure policy plus the
  // menu payload and the store actions the rows dispatch to.
  const ctx: BranchMenuContext = {
    ...policy,
    b,
    cur,
    isCurrent,
    headOid,
    repoPath,
    workdir,
    branches,
    worktrees,
    canFf,
    prsUnsupported,
    act,
    run,
    requestRemoveWorktree,
    close,
    requestConfirm,
    requestPrompt,
    openHandoff,
    openDeleteWorktree,
    showToast,
    openCreateBranchFrom,
    openCreatePr,
    openCompare,
    createPatchAt,
    checkoutBranch,
    checkoutRemoteBranch,
    removeBranch,
    renameBranchTo,
    setUpstreamFor,
    pushBranch,
    publishBranch,
    pull,
    push,
    forcePush,
    deleteRemoteBranch,
    mergeInto,
    rebaseOnto,
    fastForwardTo,
    resetBranchTo,
    cherryPickCommit,
    revertCommit,
    createTagAt,
    createAnnotatedTagAt,
    createWorktreeAt,
    openWorktree,
  };

  // Forge link eligibility (branchUrl / forgeName) is derived in the pure policy,
  // mirroring the commit menu — the component stays a painter.

  // The branch is named once, here — rows below never repeat it.
  const heading = (
    <div className="flex w-full items-center gap-1.5">
      <BranchIcon className="h-3.5 w-3.5 shrink-0 text-[color:var(--accent)]" />
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-neutral-800 dark:text-neutral-100">
        {b}
      </span>
      {isCurrent && <span className="shrink-0 text-[10px] font-medium text-[color:var(--accent)]">current</span>}
      {aheadBehind && <span className="shrink-0 font-mono text-[10.5px] text-neutral-400">{aheadBehind}</span>}
      {existingWt && (
        <span className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
          <TreeIcon className="h-3 w-3" />
          worktree
        </span>
      )}
    </div>
  );

  const top = quickActionItems(ctx);
  const integrate = integrateItems(ctx);
  const create = createItems(ctx);

  // ---- copy (used constantly, kept in plain sight): the branch's name and tip
  // SHA. A branch pill's name isn't shown in the right panel, so grabbing it here
  // is the natural quick action. ----
  const copy: MenuItem[] = [
    { label: "Copy branch name", icon: <CopyIcon className="h-4 w-4" />, onClick: () => { close(); void navigator.clipboard?.writeText(b); } },
  ];
  if (tip) {
    copy.push({ label: "Copy tip SHA", icon: <HashIcon className="h-4 w-4" />, onClick: () => { close(); void navigator.clipboard?.writeText(tip); } });
  }

  // ---- open on the forge ----
  const openRemote: MenuItem[] = [];
  if (branchUrl) {
    openRemote.push({
      label: forgeName ? `View on ${forgeName}` : "View on remote",
      icon: <ExternalLinkIcon className="h-4 w-4" />,
      onClick: () => { close(); openExternalUrl(branchUrl); },
    });
  }

  const worktree = worktreeItems(ctx);
  const reset = resetItems(ctx);
  const danger = dangerZoneItems(ctx);

  // Groups, in order. The Worktree fan reads as one group with the top
  // quick-actions above it (Open worktree is promoted there), so they share a
  // group; the intent groups below each get their own. Integrate is last before
  // Reset / Danger zone, so its Revert row sits next to Reset at the bottom.
  // An empty group is skipped by the panel — no menu computes a boundary.
  const groups: MenuItem[][] = [
    [...top, ...worktree],
    create,
    copy,
    openRemote,
    integrate,
    reset,
    danger.length
      ? [{ label: "Danger zone", icon: <WarningIcon className="h-4 w-4" />, tone: "danger", submenu: danger }]
      : [],
  ];

  return <MenuPanel left={menu.x} top={menu.y} groups={groups} onClose={close} width={248} heading={heading} />;
}
