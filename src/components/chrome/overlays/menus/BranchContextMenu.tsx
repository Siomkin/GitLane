import { api } from "@/lib/api";
import { defaultPublishTarget } from "@/lib/branchSync";
import { openExternalUrl } from "@/lib/openExternal";
import { validateBranchName } from "@/lib/refName";
import { startWorktreeHandoff } from "@/lib/worktreeHandoff";
import {
  BranchIcon,
  CheckIcon,
  CompareIcon,
  CopyIcon,
  ExternalLinkIcon,
  FolderIcon,
  HashIcon,
  PlusIcon,
  PullIcon,
  PushIcon,
  TreeIcon,
  WarningIcon,
} from "@/components/ui/icons";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { MenuPanel, useBranchOp, type MenuItem } from "@/components/chrome/overlays/shared";
import { previewConfirm } from "./previewConfirm";
import { promptAnnotatedTag, promptCompareBranch, promptCreateWorktree } from "./prompts";
import { confirmRebase } from "./rebaseConfirm";
import {
  deriveBranchContextMenuPolicy,
  MAIN_WORKTREE_DELETE_DISABLED_REASON,
} from "./branchContextMenuPolicy";
import { useBranchFastForwardProbe } from "./useBranchFastForwardProbe";
import { useRemoveWorktree } from "./useRemoveWorktree";

export function BranchContextMenu() {
  const menu = useUi((s) => s.contextMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const requestPrompt = useUi((s) => s.requestPrompt);
  const openHandoff = useUi((s) => s.openHandoff);
  const openDeleteWorktree = useUi((s) => s.openDeleteWorktree);
  const showToast = useUi((s) => s.showToast);
  const openCreateBranchFrom = useUi((s) => s.openCreateBranchFrom);
  const openCompare = useRepo((s) => s.openCompare);
  const forge = useRepo((s) => s.forge);
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
  const {
    info,
    tip,
    tipShort,
    upstream,
    existingWorktree: existingWt,
    existingWorktreeInfo: existingWtInfo,
    canHandOff,
    canRemoveWorktree,
    needsPublishPrompt,
    isLocal,
    isRemote,
    remoteCheckout,
    remoteCheckoutHasLocal,
    aheadBehind,
    worktreeCheckedOut: wtCheckedOut,
    worktreeRef: wtRef,
    handoffHere,
    localDeleteMode,
    remoteDeleteTarget,
    branchUrl,
    forgeName,
  } = policy;

  const act = (op: () => Promise<string>) => {
    close();
    void run(op);
  };

  const resetHeadPrecondition = { branch: cur, oid: headOid };
  const promptPublishBranch = () =>
    requestPrompt({
      title: `Publish ${b}`,
      message: `Remote branch for ${b} to push to and pull from.`,
      placeholder: "origin/branch",
      defaultValue: defaultPublishTarget(branches, b, upstream, info?.sync?.status !== "staleUpstream"),
      confirmLabel: "Publish",
      onSubmit: (up) => void run(() => publishBranch(b, up)),
    });
  const pushLocalBranch = () => {
    if (needsPublishPrompt) {
      promptPublishBranch();
      return;
    }
    act(() => pushBranch(b));
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

  // ---- everyday actions (lead the menu) ----
  const top: MenuItem[] = [];
  if (isLocal && isCurrent) {
    top.push({ label: "Pull (fast-forward only)", icon: <PullIcon className="h-4 w-4" />, onClick: () => { close(); void pull(); } });
    top.push({
      label: "Push",
      icon: <PushIcon className="h-4 w-4" />,
      onClick: needsPublishPrompt ? promptPublishBranch : () => { close(); void push(); },
    });
  } else if (isLocal) {
    top.push({ label: `Push ${b}`, icon: <PushIcon className="h-4 w-4" />, onClick: pushLocalBranch });
  }
  // Open worktree stays a promoted one-click; the rest of worktree management is
  // grouped in the Worktree fan below.
  if (existingWt) {
    top.push({
      label: "Open worktree",
      icon: <FolderIcon className="h-4 w-4 text-[color:var(--accent)]" />,
      onClick: () => { close(); void openWorktree(existingWt.path); },
    });
  }
  if (!isCurrent && !existingWt) {
    top.push({
      label: remoteCheckout ? `Checkout ${remoteCheckout.branch}` : isRemote ? `Checkout ${b} (detached)` : `Checkout ${b}`,
      icon: <CheckIcon className="h-4 w-4" />,
      onClick: remoteCheckout
        ? () => act(() => checkoutRemoteBranch(remoteCheckout.remote, remoteCheckout.branch))
        : () => act(() => checkoutBranch(b)),
    });
    if (isRemote && remoteCheckoutHasLocal) {
      top.push({
        label: `Checkout ${b} detached`,
        icon: <HashIcon className="h-4 w-4" />,
        onClick: () => act(() => checkoutBranch(b)),
      });
    }
  }

  // ---- integrate: identical structure to the commit menu — Cherry-pick and
  // Revert are flat rows acting on the tip commit; the branch-level integrate
  // verbs (fast-forward / merge / rebase onto ‹b›) fold into one submenu. Shown
  // whenever there's a current branch and a tip, so the branch pill matches the
  // commit menu on the same row (including on the current branch). ----
  // The "onto current" ops are hidden when the tip is HEAD (the branch is
  // current, or points at HEAD) — they'd be no-ops there, and cherry-picking HEAD
  // leaves git in an empty cherry-pick sequence. Revert stays. Same gate as the
  // commit menu at HEAD, so the two menus stay identical on the current branch.
  const integrate: MenuItem[] = [];
  if (tip && cur) {
    // "Self" means the tip is already current — hide the onto-current ops (they'd
    // be no-ops and cherry-pick would leave an empty sequence). Guard on the menu
    // snapshot (isCurrent), the live name match (b === cur), AND the oid match —
    // so an unborn/odd summary with a null headOid can't slip the ops through.
    const selfTarget = isCurrent || b === cur || (headOid != null && tip === headOid);
    if (!selfTarget) {
      integrate.push({ label: `Cherry-pick onto ${cur}`, onClick: () => act(() => cherryPickCommit(tip)) });
    }
    integrate.push({ label: "Revert commit", onClick: () => act(() => revertCommit(tip)) });
    if (!selfTarget) {
      const integrateChildren: MenuItem[] = [];
      if (canFf) integrateChildren.push({ label: `Fast-forward to ${b}`, onClick: () => act(() => fastForwardTo(b, cur)) });
      integrateChildren.push({ label: `Merge ${b}`, onClick: () => act(() => mergeInto(b, cur)) });
      integrateChildren.push({
        label: `Rebase onto ${b}`,
        onClick: () =>
          confirmRebase({
            source: cur,
            onto: b,
            needsCheckout: false,
            requestConfirm,
            proceed: () => act(() => rebaseOnto(cur, b)),
          }),
      });
      integrate.push({ label: "Integrate into current", note: `into ${cur}`, submenu: integrateChildren });
    }
    // The section's first row carries the group glyph, matching the commit menu.
    integrate[0] = { ...integrate[0], icon: <BranchIcon className="h-4 w-4" /> };
  }

  // ---- create: branch creation is a flat row; the rarer create targets and the
  // compare variants fold into their own submenus. ----
  const create: MenuItem[] = [
    { label: "Create branch here…", icon: <PlusIcon className="h-4 w-4" />, onClick: () => openCreateBranchFrom(b) },
  ];
  {
    const createChildren: MenuItem[] = [];
    if (tip) {
      createChildren.push({
        label: "Tag here…",
        onClick: () => requestPrompt({ title: `Create tag at ${tipShort}`, placeholder: "v1.0.0", confirmLabel: "Create tag", onSubmit: (name) => void run(() => createTagAt(name, tip)) }),
      });
      createChildren.push({ label: "Annotated tag here…", onClick: () => promptAnnotatedTag(requestPrompt, run, createAnnotatedTagAt, tip, b) });
    }
    // Worktree *creation* is a create verb; managing an existing worktree lives
    // on the worktree pill / navigator row (the single home). When the branch is
    // already checked out in a linked worktree, git refuses a second checkout,
    // so create detached at the tip and say so in the prompt.
    createChildren.push({
      label: "New worktree here…",
      onClick: () =>
        promptCreateWorktree(requestPrompt, run, createWorktreeAt, wtRef, workdir, b, {
          detachedAt: wtCheckedOut && tipShort ? tipShort : undefined,
        }),
    });
    if (tip) createChildren.push({ label: "Patch from commit", onClick: () => act(() => createPatchAt(tip)) });
    create.push({ label: "Create", submenu: createChildren });
  }
  if (tip) {
    const compareChildren: MenuItem[] = [];
    if (upstream) {
      compareChildren.push({
        label: "Compare with upstream",
        onClick: () => { close(); void openCompare({ base: upstream, head: b, baseLabel: upstream, headLabel: b, scope: "upstream", title: `Comparing ${b} with ${upstream}` }); },
      });
    }
    compareChildren.push({
      label: "Compare with branch…",
      onClick: () => promptCompareBranch(requestPrompt, openCompare, branches, b, cur),
    });
    create.push({ label: "Compare", icon: <CompareIcon className="h-4 w-4" />, submenu: compareChildren });
  }

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

  // ---- worktree (branch-only): a branch checked out in a linked worktree shows
  // as a branch pill with no separate worktree pill, so the worktree-management
  // actions — reclaim the branch here, copy its path, hand off, remove — are
  // grouped here (Open worktree stays promoted on top as the one-click). ----
  const worktree: MenuItem[] = [];
  if (existingWt) {
    const children: MenuItem[] = [];
    // The escape hatch: git refuses to check out a branch another worktree holds,
    // so plain Checkout is hidden — but the branch can be *moved* here (detach it
    // there, check it out here) via the hand-off dialog with the open worktree
    // preselected. A prunable holder can't run the detach step (no dead click).
    if (handoffHere) {
      children.push({
        label: "Check out here…",
        onClick: () =>
          startWorktreeHandoff({
            branch: b,
            sourcePath: existingWt.path,
            worktrees,
            sourceChanges: null,
            destPath: handoffHere.value,
            openHandoff,
            onNoDestinations: () => showToast("No worktree to check out into.", "error"),
          }),
      });
    }
    children.push({ label: "Copy worktree path", onClick: () => { close(); void navigator.clipboard?.writeText(existingWt.path); } });
    // Hand off eligibility is derived in the pure policy (source valid + a real
    // destination exists), keeping the menu component a dumb painter.
    if (canHandOff) {
      children.push({
        label: "Hand off to…",
        onClick: () =>
          startWorktreeHandoff({
            branch: b,
            sourcePath: existingWt.path,
            worktrees,
            sourceChanges: null,
            openHandoff,
            onNoDestinations: () => showToast("No other worktree to hand off to.", "error"),
          }),
      });
    }
    // Git refuses to remove the main worktree; the policy offers Remove for linked ones only.
    if (canRemoveWorktree) {
      children.push({
        label: "Remove worktree",
        danger: true,
        sep: true,
        // Shares the worktree row menu's probe-then-confirm so a dirty worktree
        // is warned about and force-removed on confirm (GL-296).
        onClick: () => void requestRemoveWorktree({ name: existingWtInfo?.name ?? existingWt.path, path: existingWt.path, branch: b, head: existingWtInfo?.head ?? null, locked: existingWtInfo?.locked ?? false }),
      });
    }
    worktree.push({ label: "Worktree", icon: <TreeIcon className="h-4 w-4 text-[color:var(--accent)]" />, note: existingWt.path, submenu: children });
  }

  // ---- reset: a first-level, danger-toned submenu — kept at the same depth as
  // the commit menu's Reset, never buried inside the Danger zone group. ----
  const resetMode = (mode: "soft" | "mixed" | "hard", label: string, message: string): MenuItem => ({
    label,
    danger: mode === "hard",
    onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${b}?`, message, confirmLabel: `Reset (${mode})`, danger: mode === "hard", preview: () => repoPath && tip ? api.previewReset(repoPath, tip, mode) : Promise.reject(new Error("No repository")), onConfirm: (preview) => tip && void run(() => resetBranchTo(cur, tip, mode, preview)), headPrecondition: resetHeadPrecondition }),
  });
  const reset: MenuItem[] =
    tip && cur && !isCurrent
      ? [{
          label: `Reset ${cur} to ${b}`,
          icon: <WarningIcon className="h-4 w-4" />,
          tone: "danger",
          submenu: [
            resetMode("soft", "Soft — keep changes staged", "Soft reset — changes are kept staged."),
            resetMode("mixed", "Mixed — keep changes unstaged", "Mixed reset — changes are kept in the working tree, unstaged."),
            resetMode("hard", "Hard — discard changes", "Hard reset — all uncommitted working-tree changes will be permanently discarded."),
          ],
        }]
      : [];

  // ---- danger zone: the rarer branch-only destructive verbs (rename, force
  // push, upstream, delete) — Reset lives above it, not inside. ----
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
      sep: danger.length > 0,
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
    danger.push({ label: `Delete ${b} on remote`, danger: true, sep: danger.length > 0, onClick: () => void previewConfirm({ requestConfirm, title: `Delete ${remoteBranch} on ${remote}?`, message: `The branch will be deleted on the remote (${remote}). This affects everyone using it and can't be undone here.`, confirmLabel: "Delete on remote", danger: true, preview: () => repoPath ? api.previewDeleteRemoteBranch(repoPath, remote, remoteBranch) : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => deleteRemoteBranch(remote, remoteBranch, tip)) }) });
  }

  // Assemble with a separator at each section boundary. The Worktree fan reads as
  // one group with the top quick-actions above it (Open worktree is promoted
  // there), so it joins them with no separator; the intent groups below do get one.
  const items: MenuItem[] = [...top, ...worktree];
  for (const section of [integrate, create, copy]) {
    if (section.length) {
      section[0] = { ...section[0], sep: items.length > 0 };
      items.push(...section);
    }
  }
  if (openRemote.length) {
    openRemote[0] = { ...openRemote[0], sep: items.length > 0 };
    items.push(...openRemote);
  }
  if (reset.length) {
    reset[0] = { ...reset[0], sep: items.length > 0 };
    items.push(...reset);
  }
  if (danger.length) {
    items.push({ label: "Danger zone", icon: <WarningIcon className="h-4 w-4" />, tone: "danger", sep: items.length > 0, submenu: danger });
  }

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={248} heading={heading} />;
}
