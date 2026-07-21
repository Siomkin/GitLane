import { useEffect, useState } from "react";
import { api, BranchKind } from "@/lib/api";
import { defaultPublishTarget } from "@/lib/branchSync";
import { findOtherBranchWorktree } from "@/lib/graphActions";
import { remoteTrackingCheckoutCandidate } from "@/lib/remoteBranches";
import { validateBranchName } from "@/lib/refName";
import {
  handoffDestinationHere,
  handoffDestinationOptions,
  handoffSourceValid,
  startWorktreeHandoff,
} from "@/lib/worktreeHandoff";
import {
  BranchIcon,
  CheckIcon,
  CompareIcon,
  CopyIcon,
  FolderIcon,
  HashIcon,
  PlusIcon,
  PullIcon,
  PushIcon,
  TreeIcon,
  WarningIcon,
} from "@/components/ui/icons";
import { useRemoveWorktree } from "./useRemoveWorktree";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { MenuPanel, useBranchOp, type MenuItem } from "@/components/chrome/overlays/shared";
import { previewConfirm } from "./previewConfirm";
import { promptAnnotatedTag, promptCompareBranch, promptCreateWorktree } from "./prompts";
import { confirmRebase } from "./rebaseConfirm";

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

  // Can the current branch fast-forward to this one? (branch is a descendant of
  // cur). Probed async like the drag-drop ActionMenu so the FF item only shows
  // when it would actually succeed.
  const branch = menu?.branch ?? null;
  const [canFf, setCanFf] = useState(false);
  useEffect(() => {
    setCanFf(false);
    if (!repoPath || !branch || !cur || branch === cur) return;
    // The menu payload carries only the display name, so a local/remote pair
    // sharing it is unresolvable here — fail closed (no FF offer) like the
    // store's revisionSnapshot does, instead of probing whichever ref happens
    // to come first in the list.
    const targetMatches = branches.filter((candidate) => candidate.name === branch);
    const targetOid = targetMatches.length === 1 ? targetMatches[0].target : null;
    const currentOid = branches.find(
      (candidate) => candidate.kind === BranchKind.Local && candidate.name === cur,
    )?.target;
    if (!targetOid || !currentOid) return;
    let alive = true;
    api
      .canFastForward(repoPath, targetOid, currentOid)
      .then((ok) => alive && setCanFf(ok))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repoPath, branch, branches, cur]);

  if (!menu) return null;

  const { isCurrent } = menu;
  const b = menu.branch;
  // Resolve the menu's ref only on a UNIQUE display-name match. The payload
  // carries no kind, so a local/remote pair sharing the name is unresolvable —
  // leave `info` unset and every tip/kind-derived action (reset to tip,
  // cherry-pick tip, tag here, local-only mutations) fails closed with it,
  // matching the FF probe above and the store's revisionSnapshot.
  const infoMatches = branches.filter((x) => x.name === b);
  const info = infoMatches.length === 1 ? infoMatches[0] : undefined;
  const tip = info?.target ?? null;
  const tipShort = tip ? tip.slice(0, 7) : null;
  const upstream = info?.upstream ?? null;
  const existingWt = findOtherBranchWorktree(worktrees, b, workdir);
  // The full info for that worktree (findOtherBranchWorktree returns the leaner
  // WorktreeRef), so we know whether it's the main worktree — git refuses to
  // remove that one, so "Remove worktree" is only offered for linked ones.
  const existingWtInfo = existingWt ? worktrees.find((w) => w.path === existingWt.path) : null;

  const act = (op: () => Promise<string>) => {
    close();
    void run(op);
  };

  const needsPublishPrompt =
    info?.sync?.status === "noUpstream" || info?.sync?.status === "staleUpstream";
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

  // Remote-tracking refs (origin/…) reach this same menu, but local-only
  // mutations (push the ref, set its upstream, rename/delete it) are nonsensical
  // there — gate those on `isLocal`. Integrate/worktree/reset/tag actions stay,
  // since "reset cur to origin/main" etc. are exactly what you want on a remote.
  // `isLocal` is a POSITIVE check so an unresolved ref (missing from the branches
  // store) fails closed — local-only mutations hide rather than show on a remote.
  const isLocal = info?.kind === BranchKind.Local;
  const isRemote = info?.kind === BranchKind.Remote;
  const remoteCheckout = remoteTrackingCheckoutCandidate(b, branches);
  const remoteCheckoutHasLocal = remoteCheckout
    ? branches.some((candidate) =>
        candidate.kind === BranchKind.Local && candidate.name === remoteCheckout.branch)
    : false;
  const sync = info?.sync ?? null;
  const aheadBehind = sync && sync.upstream ? `↑${sync.ahead} ↓${sync.behind}` : null;
  // `git worktree add <path> <branch>` errors if <branch> is already checked out
  // anywhere; create the worktree detached at the tip in that case.
  const wtCheckedOut = isCurrent || worktrees.some((w) => w.branch === b);
  const wtRef = wtCheckedOut && tip ? tip : b;

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
  if (existingWt) {
    top.push({
      label: "Open worktree",
      icon: <FolderIcon className="h-4 w-4 text-[color:var(--accent)]" />,
      onClick: () => { close(); void openWorktree(existingWt.path); },
    });
    // The escape hatch: git refuses to check out a branch that another worktree
    // holds, so plain "Checkout" is hidden — but the branch can still be *moved*
    // here (detach it there, check it out here, carrying any uncommitted work).
    // That matters most when the holder is a stale agent scratch worktree the
    // user never wants to open. Runs through the hand-off dialog with the open
    // worktree preselected, so the multi-step move stays confirmable + visible.
    const here = handoffDestinationHere(worktrees, existingWt.path, workdir);
    // A prunable holder (its directory is gone) can't run the hand-off's
    // detach step — git would fail inside the missing worktree, so don't
    // offer a dead click.
    if (isLocal && here && handoffSourceValid(worktrees, existingWt.path)) {
      top.push({
        label: "Check out here…",
        icon: <CheckIcon className="h-4 w-4" />,
        onClick: () => {
          close();
          startWorktreeHandoff({
            branch: b,
            sourcePath: existingWt.path,
            worktrees,
            // The branch lives in another worktree, not the open repo, so its
            // uncommitted state isn't known here — carry conditionally.
            sourceChanges: null,
            destPath: here.value,
            openHandoff,
            onNoDestinations: () => showToast("No worktree to check out into.", "error"),
          });
        },
      });
    }
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

  // ---- intent groups, most-used first: Create / Integrate / Worktree / Compare ----
  const groups: MenuItem[] = [];
  {
    const children: MenuItem[] = [
      { label: "Branch from here…", onClick: () => openCreateBranchFrom(b) },
    ];
    if (tip) {
      children.push({
        label: "Tag here…",
        onClick: () => requestPrompt({ title: `Create tag at ${tipShort}`, placeholder: "v1.0.0", confirmLabel: "Create tag", onSubmit: (name) => void run(() => createTagAt(name, tip)) }),
      });
      children.push({ label: "Annotated tag here…", onClick: () => promptAnnotatedTag(requestPrompt, run, createAnnotatedTagAt, tip, b) });
    }
    groups.push({ label: "Create", icon: <PlusIcon className="h-4 w-4" />, submenu: children });
  }
  if (!isCurrent && cur) {
    const children: MenuItem[] = [];
    if (canFf) children.push({ label: `Fast-forward to ${b}`, onClick: () => act(() => fastForwardTo(b, cur)) });
    children.push({ label: `Merge ${b}`, onClick: () => act(() => mergeInto(b, cur)) });
    children.push({
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
    if (tip) {
      children.push({ label: "Cherry-pick tip", onClick: () => act(() => cherryPickCommit(tip)) });
      children.push({ label: "Revert tip", onClick: () => act(() => revertCommit(tip)) });
    }
    groups.push({ label: "Integrate into current", icon: <BranchIcon className="h-4 w-4" />, note: `into ${cur}`, submenu: children });
  }
  {
    // One home for everything worktree: create one when the branch has none,
    // manage the existing one otherwise ("Open worktree" stays promoted on top
    // as the everyday one-click, since the branch can't be checked out here —
    // the in-group copy is labelled differently so assistive tech can tell the
    // two menu items apart).
    const newWorktree: MenuItem = {
      label: "New worktree here…",
      onClick: () =>
        promptCreateWorktree(requestPrompt, run, createWorktreeAt, wtRef, workdir, b, {
          detachedAt: wtCheckedOut && tipShort ? tipShort : undefined,
        }),
    };
    const children: MenuItem[] = [];
    if (existingWt) {
      children.push({ label: "Open this worktree", onClick: () => { close(); void openWorktree(existingWt.path); } });
      children.push({ label: "Copy worktree path", onClick: () => { close(); void navigator.clipboard?.writeText(existingWt.path); } });
      // Only offer the hand-off when the source can still run the detach step
      // (not prunable) and a valid destination actually exists (bare / prunable
      // worktrees are filtered out), so it's never a dead click.
      if (
        isLocal &&
        !isCurrent &&
        handoffSourceValid(worktrees, existingWt.path) &&
        handoffDestinationOptions(worktrees, existingWt.path).length > 0
      ) {
        children.push({
          label: "Hand off to…",
          onClick: () =>
            startWorktreeHandoff({
              branch: b,
              sourcePath: existingWt.path,
              worktrees,
              // The branch lives in another worktree, not the open repo, so its
              // uncommitted state isn't known here — carry conditionally.
              sourceChanges: null,
              openHandoff,
              onNoDestinations: () => showToast("No other worktree to hand off to.", "error"),
            }),
        });
      }
      children.push(newWorktree);
      if (!existingWtInfo?.isMain) {
        children.push({
          label: "Remove worktree",
          danger: true,
          sep: true,
          // Shares the worktree row menu's probe-then-confirm so a dirty
          // worktree is warned about and force-removed here too (GL-296).
          onClick: () => void requestRemoveWorktree({ name: existingWtInfo?.name ?? existingWt.path, path: existingWt.path, branch: b, head: existingWtInfo?.head ?? null, locked: existingWtInfo?.locked ?? false }),
        });
      }
    } else {
      children.push(newWorktree);
    }
    groups.push({ label: "Worktree", icon: <TreeIcon className={existingWt ? "h-4 w-4 text-[color:var(--accent)]" : "h-4 w-4"} />, note: existingWt?.path, submenu: children });
  }
  if (tip) {
    const children: MenuItem[] = [];
    if (upstream) {
      children.push({
        label: "Compare with upstream",
        onClick: () => { close(); void openCompare({ base: upstream, head: b, baseLabel: upstream, headLabel: b, scope: "upstream", title: `Comparing ${b} with ${upstream}` }); },
      });
    }
    children.push({
      label: "Compare with branch…",
      onClick: () => promptCompareBranch(requestPrompt, openCompare, branches, b, cur),
    });
    groups.push({ label: "Compare", icon: <CompareIcon className="h-4 w-4" />, submenu: children });
  }

  // ---- copy (used constantly, kept in plain sight) ----
  const copy: MenuItem[] = [
    { label: "Copy branch name", icon: <CopyIcon className="h-4 w-4" />, onClick: () => { close(); void navigator.clipboard?.writeText(b); } },
  ];
  if (tip) {
    copy.push({ label: "Copy tip SHA", icon: <HashIcon className="h-4 w-4" />, onClick: () => { close(); void navigator.clipboard?.writeText(tip); } });
  }

  // ---- danger zone: rare + destructive, folded away behind one row ----
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
  if (tip && cur && !isCurrent) {
    danger.push({ label: `Reset ${cur} to ${b}`, header: true, danger: true, sep: danger.length > 0 });
    danger.push({ label: "Soft — keep changes staged", indent: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${b}?`, message: "Soft reset — changes are kept staged.", confirmLabel: "Reset (soft)", preview: () => repoPath ? api.previewReset(repoPath, tip, "soft") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetBranchTo(cur, tip, "soft")), headPrecondition: resetHeadPrecondition }) });
    danger.push({ label: "Mixed — keep changes unstaged", indent: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${b}?`, message: "Mixed reset — changes are kept in the working tree, unstaged.", confirmLabel: "Reset (mixed)", preview: () => repoPath ? api.previewReset(repoPath, tip, "mixed") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetBranchTo(cur, tip, "mixed")), headPrecondition: resetHeadPrecondition }) });
    danger.push({ label: "Hard — discard changes", indent: true, danger: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${b}?`, message: "Hard reset — all uncommitted working-tree changes will be permanently discarded.", confirmLabel: "Reset (hard)", danger: true, preview: () => repoPath ? api.previewReset(repoPath, tip, "hard") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetBranchTo(cur, tip, "hard")), headPrecondition: resetHeadPrecondition }) });
  }
  if (isLocal) {
    // Set upstream is rare — tuck it down at the end, just above Delete.
    danger.push({
      label: upstream ? `Change upstream (${upstream})…` : "Set upstream…",
      sep: danger.length > 0,
      onClick: () => requestPrompt({ title: `Set upstream for ${b}`, message: "Remote-tracking ref to track (must already exist).", placeholder: "origin/branch", defaultValue: upstream ?? `origin/${b}`, confirmLabel: "Set upstream", onSubmit: (up) => void run(() => setUpstreamFor(b, up)) }),
    });
    if (!isCurrent && existingWt && !existingWtInfo?.isMain) {
      danger.push({ label: `Delete ${b} & worktree…`, danger: true, onClick: () => { close(); openDeleteWorktree({ branch: b, worktreePath: existingWt.path }); } });
    } else if (!isCurrent && existingWt) {
      danger.push({ label: `Delete ${b}`, disabled: true, disabledReason: "Checked out in the main worktree." });
    } else if (!isCurrent) {
      danger.push({ label: `Delete ${b}`, danger: true, onClick: () => void previewConfirm({ requestConfirm, title: `Delete branch ${b}?`, message: "The branch ref will be removed. Unmerged commits may be lost.", confirmLabel: "Delete branch", danger: true, preview: () => repoPath ? api.previewDeleteBranch(repoPath, b) : Promise.reject(new Error("No repository")), onConfirm: (impact) => void run(() => removeBranch(b, impact.expectedOid, repoPath ?? "", true)) }) });
    }
  }
  if (isRemote) {
    // The backend attributes each remote branch to its remote (matched against
    // the known remote list), so use that rather than splitting on the first `/`
    // — a slash-containing remote name would otherwise target the wrong remote.
    const remote = info?.remote ?? null;
    const remoteBranch = remote && b.startsWith(`${remote}/`) ? b.slice(remote.length + 1) : null;
    if (remote && remoteBranch && tip) {
      danger.push({ label: `Delete ${b} on remote`, danger: true, sep: danger.length > 0, onClick: () => void previewConfirm({ requestConfirm, title: `Delete ${remoteBranch} on ${remote}?`, message: `The branch will be deleted on the remote (${remote}). This affects everyone using it and can't be undone here.`, confirmLabel: "Delete on remote", danger: true, preview: () => repoPath ? api.previewDeleteRemoteBranch(repoPath, remote, remoteBranch) : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => deleteRemoteBranch(remote, remoteBranch, tip)) }) });
    }
  }

  // Assemble with a separator at each section boundary.
  const items: MenuItem[] = [...top];
  if (groups.length) {
    groups[0] = { ...groups[0], sep: items.length > 0 };
    items.push(...groups);
  }
  if (copy.length) {
    copy[0] = { ...copy[0], sep: items.length > 0 };
    items.push(...copy);
  }
  if (danger.length) {
    items.push({ label: "Danger zone", icon: <WarningIcon className="h-4 w-4" />, tone: "danger", sep: items.length > 0, submenu: danger });
  }

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={248} heading={heading} />;
}
