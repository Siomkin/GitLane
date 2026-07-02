import { useEffect, useRef, useState } from "react";
import { api, type BranchInfo, type DestructivePreview } from "@/lib/api";
import {
  fileWriteGuard,
  findGuardedFile,
  guardedAdvancedWriteMessage,
} from "@/lib/advancedRepoState";
import { fullCommitMessage, splitCommitMessage } from "@/lib/commitMessage";
import {
  buildGraphActionSpecs,
  findOtherBranchWorktree,
  type FastForwardMoves,
  type GraphActionKind,
} from "@/lib/graphActions";
import { focusRing } from "@/lib/ui";
import { basename } from "@/lib/paths";
import { handoffDestinationOptions, promptWorktreeHandoff } from "@/lib/worktreeHandoff";
import {
  BranchIcon,
  CheckIcon,
  ClockIcon,
  CompareIcon,
  CopyIcon,
  FileTextIcon,
  FolderIcon,
  HashIcon,
  MinusIcon,
  PlusIcon,
  PullIcon,
  PushIcon,
  StashIcon,
  TrashIcon,
  TreeIcon,
  WarningIcon,
} from "@/components/ui/icons";
import { defaultPublishTarget } from "@/lib/branchSync";
import { isActiveWorktreePath, trimTrailingSlash } from "@/lib/worktrees";
import { useDismiss } from "@/hooks/useDismiss";
import { useRepo } from "@/store/repo";
import type { RepoState } from "@/store/repoTypes";
import { buildCommitBatchPlan, buildSquashMessage, getSquashEligibility, isCommitReachableFromRemote } from "@/store/selection";
import { useUi, type ConfirmRequest, type PromptRequest } from "@/store/ui";
import { Backdrop, MenuPanel, useBranchOp, useFittedMenuPosition, type MenuItem } from "./shared";

type PromptFn = (req: PromptRequest) => void;
type RunFn = (op: () => Promise<string>) => void;

type ConfirmFn = (req: ConfirmRequest) => void;

type HeadPrecondition = {
  branch: string | null;
  oid: string | null;
};

// Monotonic token shared by every destructive-preview invocation. The preview
// IPC is async, so a later click — or a repo switch — can land before an earlier
// preview resolves. Both the token and the captured repo path are re-checked
// after the await so only the newest click, still on the same repo, opens a
// confirm. Without this a stale result could (re)open a dialog whose `onConfirm`
// runs against the now-active repo — a cross-repo destructive action. GL-42 review.
let previewToken = 0;

const previewConfirm = async ({
  requestConfirm,
  title,
  message,
  confirmLabel,
  danger,
  preview,
  onConfirm,
  headPrecondition,
}: {
  requestConfirm: ConfirmFn;
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  preview: () => Promise<DestructivePreview>;
  onConfirm: () => void;
  headPrecondition?: HeadPrecondition;
}) => {
  // Local, disposable preview read: it only enriches this confirmation modal
  // and does not become shared repo state, so it stays at the UI boundary.
  const token = ++previewToken;
  const repoAtClick = useRepo.getState().summary?.path ?? null;
  const isCurrent = () =>
    token === previewToken && useRepo.getState().summary?.path === repoAtClick;
  const headStillMatches = () => {
    if (!headPrecondition) return true;
    const summary = useRepo.getState().summary;
    return (
      summary?.headBranch === headPrecondition.branch &&
      summary?.headOid === headPrecondition.oid
    );
  };
  const showStaleHeadToast = () =>
    useUi.getState().showToast("HEAD changed; preview the reset again before confirming.", "error");
  // Destructive previews are launched from transient menus. Close the originating
  // menu before awaiting so a slow preview cannot resurrect a confirm after the
  // user dismisses that menu.
  useUi.getState().closeOverlays();
  try {
    const impact = await preview();
    if (!isCurrent()) return;
    if (!headStillMatches()) {
      showStaleHeadToast();
      return;
    }
    requestConfirm({
      title,
      message,
      details: [impact.summary, ...impact.details],
      warnings: impact.warnings,
      confirmLabel,
      danger,
      onConfirm: () => {
        if (!headStillMatches()) {
          showStaleHeadToast();
          return;
        }
        onConfirm();
      },
    });
  } catch (e) {
    if (!isCurrent()) return;
    // Fail closed: the preview also validates the operands/refs (ensure_operand +
    // rev-parse), so a failure means we can't vouch for the impact. For a safety
    // feature that's a reason to NOT offer a one-click destructive confirm at all
    // — surface the error and abort. The user can retry once it's resolved. GL-42.
    useUi.getState().showToast(`Couldn't preview the action's impact: ${String(e)}`, "error");
  }
};

/** A sibling directory path for a new worktree: `/work/repo` + `feat/x` →
 * `/work/repo-wt-feat-x`. Pre-fills the create-worktree prompt. */
function defaultWorktreePath(base: string, ref: string): string {
  const trimmed = base.replace(/\/+$/, "");
  const safe = ref.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${trimmed}-wt-${safe || "detached"}`;
}

/** Prompt for a path, then create + open a worktree checked out to `reference`. */
function promptCreateWorktree(
  requestPrompt: PromptFn,
  run: RunFn,
  createWorktreeAt: (path: string, ref: string) => Promise<string>,
  reference: string,
  workdir: string,
  label: string,
) {
  requestPrompt({
    title: `Create worktree from ${label}`,
    message: "A new linked worktree is created at this path, then opened.",
    placeholder: "/path/to/worktree",
    defaultValue: defaultWorktreePath(workdir, label),
    confirmLabel: "Create worktree",
    onSubmit: (path) => run(() => createWorktreeAt(path, reference)),
  });
}

/** Branch-picker prompt for "Compare <head> with…": offers the repo's other
 * branches (current first, then locals, then remotes) as a searchable list so
 * the user selects the comparison base instead of typing it. The selected
 * branch becomes the diff base. */
function promptCompareBranch(
  requestPrompt: PromptFn,
  openCompare: RepoState["openCompare"],
  branches: BranchInfo[],
  head: string,
  cur: string | null,
) {
  const others = branches.filter((x) => x.name !== head);
  const locals = others
    .filter((x) => x.kind === "local")
    .sort((x, y) => (x.name === cur ? -1 : y.name === cur ? 1 : x.name.localeCompare(y.name)));
  const remotes = others.filter((x) => x.kind === "remote").sort((x, y) => x.name.localeCompare(y.name));
  const options = [
    ...locals.map((x) => ({ value: x.name, hint: x.name === cur ? "current" : undefined })),
    ...remotes.map((x) => ({ value: x.name, hint: "remote" })),
  ];
  requestPrompt({
    title: `Compare ${head} with…`,
    message: "Pick a branch to compare against (it becomes the base).",
    placeholder: "Search branches",
    defaultValue: cur && cur !== head ? cur : "",
    confirmLabel: "Compare",
    options,
    onSubmit: (other) => {
      const base = other.trim();
      if (!base) return;
      void openCompare({ base, head, baseLabel: base, headLabel: head, scope: "branch", title: `Comparing ${head} with ${base}` });
    },
  });
}

/** Two-step prompt (name → message) for an annotated tag at `sha`. */
function promptAnnotatedTag(
  requestPrompt: PromptFn,
  run: RunFn,
  createAnnotatedTagAt: (name: string, message: string, sha?: string) => Promise<string>,
  sha: string | undefined,
  label: string,
) {
  requestPrompt({
    title: `Create annotated tag at ${label}`,
    placeholder: "v1.0.0",
    confirmLabel: "Next",
    onSubmit: (name) =>
      requestPrompt({
        title: `Message for tag ${name}`,
        placeholder: "Tag message",
        defaultValue: name,
        confirmLabel: "Create tag",
        onSubmit: (message) => run(() => createAnnotatedTagAt(name, message, sha)),
      }),
  });
}

export function ActionMenu() {
  const menu = useUi((s) => s.actionMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const mergeInto = useRepo((s) => s.mergeInto);
  const fastForwardTo = useRepo((s) => s.fastForwardTo);
  const rebaseOnto = useRepo((s) => s.rebaseOnto);
  const checkoutBranch = useRepo((s) => s.checkoutBranch);
  const resetCurrentTo = useRepo((s) => s.resetCurrentTo);
  const repoPath = useRepo((s) => s.summary?.path ?? null);
  const run = useBranchOp();
  const panelRef = useRef<HTMLDivElement>(null);
  useDismiss(true, close, panelRef);

  const [ff, setFf] = useState<FastForwardMoves>({
    targetToSource: false,
    sourceToTarget: false,
  });
  useEffect(() => {
    setFf({ targetToSource: false, sourceToTarget: false });
    if (!menu || !repoPath) return;
    let alive = true;
    // The rev the source could move onto: a local/remote ref by name, a commit
    // by sha.
    const targetRef = menu.to.kind === "commit" ? menu.to.sha : menu.to.name;
    Promise.all([
      // targetToSource (moving the drop target forward) is only ever offered for
      // a remote ref dropped on a local branch — a local source moves the source,
      // so its reverse direction is never read. Skip the probe otherwise.
      menu.to.kind === "local" && menu.from.kind === "remote"
        ? api.canFastForward(repoPath, menu.from.name, menu.to.name)
        : Promise.resolve(false),
      menu.from.kind === "local"
        ? api.canFastForward(repoPath, targetRef, menu.from.name)
        : Promise.resolve(false),
    ])
      .then(([targetToSource, sourceToTarget]) => {
        if (alive) setFf({ targetToSource, sourceToTarget });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [menu, repoPath]);

  // Anchor at the drop point, then clamp on-screen once the panel is measured.
  const pos = useFittedMenuPosition(menu?.x ?? 0, menu?.y ?? 0, panelRef, [menu, ff]);

  if (!menu) return null;

  const { from, to } = menu;

  const act = (op: () => Promise<string>) => {
    close();
    void run(op);
  };

  const requestMixedReset = (branch: string, target: string, targetLabel: string) =>
    void previewConfirm({
      requestConfirm,
      title: `Reset ${branch} to ${targetLabel}?`,
      message: "Mixed reset — changes are kept in the working tree, unstaged.",
      confirmLabel: "Reset (mixed)",
      preview: () =>
        repoPath
          ? // `branch` (not HEAD) is the ref being reset — it's checked out in
            // onConfirm first — so the preview must be anchored on it. GL-42 review.
            api.previewReset(repoPath, target, "mixed", branch)
          : Promise.reject(new Error("No repository")),
      onConfirm: () =>
        void run(async () => {
          await checkoutBranch(branch);
          return resetCurrentTo(target, "mixed");
        }),
    });

  const handler = (kind: GraphActionKind): (() => void) => {
    // Read-only targets (a commit or a remote-tracking ref) can only receive the
    // dragged local branch — the source moves, the target never does. The rev is
    // a commit sha or the remote ref's name.
    if (to.kind !== "local") {
      const rev = to.kind === "commit" ? to.sha : to.name;
      const revLabel = to.kind === "commit" ? to.shortSha : to.name;
      switch (kind) {
        case "fast-forward-source":
          return () => act(() => fastForwardTo(rev, from.name));
        case "rebase-source":
          return () =>
            act(async () => {
              await checkoutBranch(from.name);
              return rebaseOnto(rev);
            });
        case "reset-source":
          return () => requestMixedReset(from.name, rev, revLabel);
        default:
          return () => {};
      }
    }

    switch (kind) {
      case "fast-forward-target":
        return () => act(() => fastForwardTo(from.name, to.name));
      case "fast-forward-source":
        return () => act(() => fastForwardTo(to.name, from.name));
      case "merge-target":
        return () => act(() => mergeInto(from.name, to.name));
      case "rebase-target":
        return () =>
          act(async () => {
            await checkoutBranch(to.name);
            return rebaseOnto(from.name);
          });
      case "rebase-source":
        return () =>
          act(async () => {
            await checkoutBranch(from.name);
            return rebaseOnto(to.name);
          });
      case "reset-target":
        return () => requestMixedReset(to.name, from.name, from.name);
      case "reset-source":
        return () => requestMixedReset(from.name, to.name, to.name);
      default:
        return () => {};
    }
  };

  const iconFor = (kind: GraphActionKind) =>
    kind.startsWith("fast-forward")
      ? { icon: "⏩", iconBg: "rgba(47,158,126,0.18)" }
      : kind.startsWith("rebase")
        ? { icon: "⤴", iconBg: "rgba(91,141,239,0.18)" }
        : kind.startsWith("reset")
          ? { icon: "⤓", iconBg: "rgba(224,98,111,0.18)" }
          : { icon: "⛙", iconBg: "rgba(47,158,126,0.18)" };

  const items = buildGraphActionSpecs(from, to, ff).map((spec) => ({
    ...spec,
    ...iconFor(spec.kind),
    onClick: handler(spec.kind),
  }));

  return (
    <>
      <Backdrop onClick={close} z={49} />
      <div
        ref={panelRef}
        role="menu"
        className="fixed z-50 w-[272px] overflow-y-auto rounded-xl border border-black/10 bg-white shadow-[0_18px_44px_-8px_rgba(0,0,0,0.42)] dark:border-white/10 dark:bg-neutral-800"
        style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight, animation: "gp-pop .12s ease-out" }}
      >
        <div className="border-b border-black/5 px-3.5 pb-2 pt-2.5 text-[11px] tracking-wide text-neutral-400 dark:border-white/5">
          Drop {from.name} onto {to.kind === "commit" ? to.shortSha : to.name}
        </div>
        <div className="p-1.5">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              onClick={item.onClick}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left hover:bg-black/5 dark:hover:bg-white/5 ${focusRing}`}
            >
              <span
                className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg text-sm text-neutral-700 dark:text-neutral-200"
                style={{ background: item.iconBg }}
              >
                {item.icon}
              </span>
              <span className="flex flex-col">
                <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-100">{item.label}</span>
                <span className="text-[11px] text-neutral-400">{item.sub}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
export function BranchContextMenu() {
  const menu = useUi((s) => s.contextMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const requestPrompt = useUi((s) => s.requestPrompt);
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
  const resetCurrentTo = useRepo((s) => s.resetCurrentTo);
  const cherryPickCommit = useRepo((s) => s.cherryPickCommit);
  const revertCommit = useRepo((s) => s.revertCommit);
  const createTagAt = useRepo((s) => s.createTagAt);
  const createAnnotatedTagAt = useRepo((s) => s.createAnnotatedTagAt);
  const createWorktreeAt = useRepo((s) => s.createWorktreeAt);
  const openWorktree = useRepo((s) => s.openWorktree);
  const moveBranchToWorktree = useRepo((s) => s.moveBranchToWorktree);
  const deleteBranchWithWorktree = useRepo((s) => s.deleteBranchWithWorktree);
  const removeWorktree = useRepo((s) => s.removeWorktree);
  const run = useBranchOp();

  // Can the current branch fast-forward to this one? (branch is a descendant of
  // cur). Probed async like the drag-drop ActionMenu so the FF item only shows
  // when it would actually succeed.
  const branch = menu?.branch ?? null;
  const [canFf, setCanFf] = useState(false);
  useEffect(() => {
    setCanFf(false);
    if (!repoPath || !branch || !cur || branch === cur) return;
    let alive = true;
    api
      .canFastForward(repoPath, branch, cur)
      .then((ok) => alive && setCanFf(ok))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repoPath, branch, cur]);

  if (!menu) return null;

  const { isCurrent } = menu;
  const b = menu.branch;
  const info = branches.find((x) => x.name === b);
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
  const isLocal = info?.kind === "local";
  const isRemote = info?.kind === "remote";
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
  }
  if (!isCurrent && !existingWt) {
    top.push({
      label: isRemote ? `Checkout ${b} (detached)` : `Checkout ${b}`,
      icon: <CheckIcon className="h-4 w-4" />,
      onClick: () => act(() => checkoutBranch(b)),
    });
  }

  // ---- intent groups: Compare / Integrate / Create / Worktree ----
  const groups: MenuItem[] = [];
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
  if (!isCurrent && cur) {
    const children: MenuItem[] = [];
    if (canFf) children.push({ label: `Fast-forward to ${b}`, onClick: () => act(() => fastForwardTo(b, cur)) });
    children.push({ label: `Merge ${b}`, onClick: () => act(() => mergeInto(b, cur)) });
    children.push({ label: `Rebase onto ${b}`, onClick: () => act(async () => { await checkoutBranch(cur); return rebaseOnto(b); }) });
    if (tip) {
      children.push({ label: "Cherry-pick tip", onClick: () => act(() => cherryPickCommit(tip)) });
      children.push({ label: "Revert tip", onClick: () => act(() => revertCommit(tip)) });
    }
    groups.push({ label: "Integrate into current", icon: <BranchIcon className="h-4 w-4" />, note: `into ${cur}`, submenu: children });
  }
  {
    const children: MenuItem[] = [
      { label: "Branch from here…", onClick: () => openCreateBranchFrom(b) },
      { label: "Worktree from branch…", onClick: () => promptCreateWorktree(requestPrompt, run, createWorktreeAt, wtRef, workdir, b) },
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
  if (existingWt) {
    const children: MenuItem[] = [
      { label: "Copy worktree path", onClick: () => { close(); void navigator.clipboard?.writeText(existingWt.path); showToast("Copied path"); } },
    ];
    // Only offer the hand-off when a valid destination actually exists (bare /
    // prunable worktrees are filtered out), so it's never a dead click.
    if (isLocal && !isCurrent && handoffDestinationOptions(worktrees, existingWt.path).length > 0) {
      children.push({
        label: "Hand off to…",
        onClick: () =>
          promptWorktreeHandoff({
            branch: b,
            sourcePath: existingWt.path,
            worktrees,
            // The branch lives in another worktree, not the open repo, so its
            // uncommitted state isn't known here — carry conditionally.
            sourceChanges: null,
            requestPrompt,
            requestConfirm,
            run,
            moveBranchToWorktree,
            onNoDestinations: () => showToast("No other worktree to hand off to.", "error"),
          }),
      });
    }
    if (!existingWtInfo?.isMain) {
      children.push({
        label: "Remove worktree",
        danger: true,
        onClick: () => requestConfirm({ title: `Remove worktree ${existingWtInfo?.name ?? existingWt.path}?`, message: `The linked worktree at ${existingWt.path} will be removed. ${b} and its commits are kept.${existingWtInfo?.locked ? " This worktree is locked; removing it will override the lock." : ""}`, confirmLabel: "Remove worktree", danger: true, onConfirm: () => void run(() => removeWorktree(existingWt.path, existingWtInfo?.locked ?? false)) }),
      });
    }
    groups.push({ label: "Worktree", icon: <TreeIcon className="h-4 w-4 text-[color:var(--accent)]" />, note: existingWt.path, submenu: children });
  }

  // ---- copy (used constantly, kept in plain sight) ----
  const copy: MenuItem[] = [
    { label: "Copy branch name", icon: <CopyIcon className="h-4 w-4" />, onClick: () => { close(); void navigator.clipboard?.writeText(b); showToast(`Copied ${b}`); } },
  ];
  if (tip) {
    copy.push({ label: "Copy tip SHA", icon: <HashIcon className="h-4 w-4" />, onClick: () => { close(); void navigator.clipboard?.writeText(tip); showToast(`Copied ${tipShort}`); } });
  }

  // ---- danger zone: rare + destructive, folded away behind one row ----
  const danger: MenuItem[] = [];
  if (isLocal) {
    danger.push({ label: "Manage", header: true });
    danger.push({
      label: `Rename ${b}…`,
      onClick: () => requestPrompt({ title: `Rename branch ${b}`, placeholder: "new-branch-name", defaultValue: b, confirmLabel: "Rename", onSubmit: (next) => { if (next !== b) void run(() => renameBranchTo(b, next)); } }),
    });
    if (isCurrent) {
      danger.push({
        label: "Force push (with lease)…",
        onClick: () => void previewConfirm({ requestConfirm, title: `Force-push ${b}?`, message: "Overwrites the remote branch with your local history (--force-with-lease: aborts if the remote moved since your last fetch). Use after amending or rebasing pushed commits.", confirmLabel: "Force push", danger: true, preview: () => repoPath ? api.previewForcePush(repoPath, b) : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => forcePush(b)) }),
      });
    }
  }
  if (tip && cur && !isCurrent) {
    danger.push({ label: `Reset ${cur} to ${b}`, header: true, danger: true, sep: danger.length > 0 });
    danger.push({ label: "Soft — keep changes staged", indent: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${b}?`, message: "Soft reset — changes are kept staged.", confirmLabel: "Reset (soft)", preview: () => repoPath ? api.previewReset(repoPath, tip, "soft") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetCurrentTo(tip, "soft")), headPrecondition: resetHeadPrecondition }) });
    danger.push({ label: "Mixed — keep changes unstaged", indent: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${b}?`, message: "Mixed reset — changes are kept in the working tree, unstaged.", confirmLabel: "Reset (mixed)", preview: () => repoPath ? api.previewReset(repoPath, tip, "mixed") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetCurrentTo(tip, "mixed")), headPrecondition: resetHeadPrecondition }) });
    danger.push({ label: "Hard — discard changes", indent: true, danger: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${b}?`, message: "Hard reset — all uncommitted working-tree changes will be permanently discarded.", confirmLabel: "Reset (hard)", danger: true, preview: () => repoPath ? api.previewReset(repoPath, tip, "hard") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetCurrentTo(tip, "hard")), headPrecondition: resetHeadPrecondition }) });
  }
  if (isLocal) {
    // Set upstream is rare — tuck it down at the end, just above Delete.
    danger.push({
      label: upstream ? `Change upstream (${upstream})…` : "Set upstream…",
      sep: danger.length > 0,
      onClick: () => requestPrompt({ title: `Set upstream for ${b}`, message: "Remote-tracking ref to track (must already exist).", placeholder: "origin/branch", defaultValue: upstream ?? `origin/${b}`, confirmLabel: "Set upstream", onSubmit: (up) => void run(() => setUpstreamFor(b, up)) }),
    });
    if (!isCurrent && existingWt && !existingWtInfo?.isMain) {
      danger.push({ label: `Delete ${b} & worktree…`, danger: true, onClick: () => void previewConfirm({ requestConfirm, title: `Delete branch ${b} and its worktree?`, message: `Removes the linked worktree at ${existingWt.path}, then deletes ${b}. Unmerged commits may be lost.`, confirmLabel: "Delete branch & worktree", danger: true, preview: () => repoPath ? api.previewDeleteBranch(repoPath, b) : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => deleteBranchWithWorktree(b, existingWt.path)) }) });
    } else if (!isCurrent && existingWt) {
      danger.push({ label: `Delete ${b}`, disabled: true, disabledReason: "Checked out in the main worktree." });
    } else if (!isCurrent) {
      danger.push({ label: `Delete ${b}`, danger: true, onClick: () => void previewConfirm({ requestConfirm, title: `Delete branch ${b}?`, message: "The branch ref will be removed. Unmerged commits may be lost.", confirmLabel: "Delete branch", danger: true, preview: () => repoPath ? api.previewDeleteBranch(repoPath, b) : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => removeBranch(b, true)) }) });
    }
  }
  if (isRemote) {
    const slash = b.indexOf("/");
    if (slash > 0) {
      const remote = b.slice(0, slash);
      const remoteBranch = b.slice(slash + 1);
      danger.push({ label: `Delete ${b} on remote`, danger: true, sep: danger.length > 0, onClick: () => void previewConfirm({ requestConfirm, title: `Delete ${remoteBranch} on ${remote}?`, message: `The branch will be deleted on the remote (${remote}). This affects everyone using it and can't be undone here.`, confirmLabel: "Delete on remote", danger: true, preview: () => repoPath ? api.previewDeleteRemoteBranch(repoPath, remote, remoteBranch) : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => deleteRemoteBranch(remote, remoteBranch)) }) });
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

export function CommitContextMenu() {
  const menu = useUi((s) => s.commitMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const requestPrompt = useUi((s) => s.requestPrompt);
  const showToast = useUi((s) => s.showToast);
  const openCreateBranchFrom = useUi((s) => s.openCreateBranchFrom);
  const openStackedReview = useUi((s) => s.openStackedReview);
  const openRangeReview = useUi((s) => s.openRangeReview);
  const openCompare = useRepo((s) => s.openCompare);
  const selectedCommit = useRepo((s) => s.selectedCommit);
  const summary = useRepo((s) => s.summary);
  const graph = useRepo((s) => s.graph);
  const checkoutBranch = useRepo((s) => s.checkoutBranch);
  const checkoutDetached = useRepo((s) => s.checkoutDetached);
  const cherryPickCommit = useRepo((s) => s.cherryPickCommit);
  const cherryPickMany = useRepo((s) => s.cherryPickMany);
  const revertCommit = useRepo((s) => s.revertCommit);
  const revertMany = useRepo((s) => s.revertMany);
  const squashSelection = useRepo((s) => s.squashSelection);
  const amendHeadMessage = useRepo((s) => s.amendHeadMessage);
  const createTagAt = useRepo((s) => s.createTagAt);
  const createAnnotatedTagAt = useRepo((s) => s.createAnnotatedTagAt);
  const createWorktreeAt = useRepo((s) => s.createWorktreeAt);
  const createPatchAt = useRepo((s) => s.createPatchAt);
  const resetCurrentTo = useRepo((s) => s.resetCurrentTo);
  const mergeInto = useRepo((s) => s.mergeInto);
  const rebaseOnto = useRepo((s) => s.rebaseOnto);
  const run = useBranchOp();
  if (!menu) return null;

  const { sha, shortSha } = menu;
  const cur = summary?.headBranch ?? "HEAD";
  const repoPath = summary?.path ?? null;
  const workdir = summary?.workdir ?? summary?.path ?? "";
  const resetHeadPrecondition = {
    branch: summary?.headBranch ?? null,
    oid: summary?.headOid ?? null,
  };

  const act = (op: () => Promise<string>) => {
    close();
    void run(op);
  };

  // ---- Batch menu: a range/additive selection of 2+ commits ----
  // Ordered by graph row so operation order and the inclusive compare range
  // are derived once by the pure selection helper.
  const selection = menu.selection ?? [];
  const batch = buildCommitBatchPlan(graph, selection);
  const orderedSel = batch.ordered;
  if (selection.length > 1) {
    const n = selection.length;
    const oldest = orderedSel[orderedSel.length - 1];
    const newest = orderedSel[0];
    const squash = getSquashEligibility(graph, orderedSel);
    const items: MenuItem[] = [
      { label: `${n} commits selected`, header: true },
      {
        label: `Cherry-pick ${n} commits onto ${cur}`,
        sep: true,
        onClick: () => {
          // git cherry-pick applies oldest-first; reverse the graph (newest-first)
          // order so the commits replay in chronological order.
          act(() => cherryPickMany(batch.cherryPickOrder));
        },
      },
      { label: `Revert ${n} commits`, onClick: () => act(() => revertMany(batch.revertOrder)) },
      ...(squash.ok
        ? [{
            label: `Squash ${n} commits…`,
            onClick: () =>
              requestPrompt({
                title: `Squash ${n} commits into one`,
                message: "Only local, unpublished commits at the current branch tip can be squashed.",
                placeholder: "Subject\n\nDescription",
                // Seed with the combined original messages so the squash keeps their
                // content and stays valid for repos whose commit-msg hook enforces a
                // format (e.g. Conventional Commits); a generic placeholder is rejected.
                defaultValue: buildSquashMessage(graph, orderedSel),
                multiline: true,
                confirmLabel: "Squash",
                onSubmit: (msg) => void run(() => squashSelection(orderedSel, msg)),
              }),
          }]
        : []),
      ...(batch.compareRange
        ? [{
            label: `Compare ${oldest.slice(0, 7)}…${newest.slice(0, 7)}`,
            sep: true,
            onClick: () => {
              close();
              openRangeReview(
                batch.compareRange!.base,
                batch.compareRange!.head,
                `Comparing ${n} commits`,
              );
            },
          }]
        : []),
      {
        label: `Copy ${n} commit SHAs`,
        onClick: () => {
          close();
          void navigator.clipboard?.writeText(orderedSel.join("\n"));
          showToast(`Copied ${n} SHAs`);
        },
      },
    ];
    return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={260} />;
  }

  // ---- Single-commit menu ----
  // The commit's summary/body come from the loaded graph (no standalone
  // commit-detail command exists). Falls back to the short sha when truncated.
  const commit = graph?.commits.find((c) => c.id === sha && !c.stash);
  const subject = commit?.summary ?? shortSha;
  const body = commit?.body ?? "";
  const canRewordHead =
    !!summary?.headBranch &&
    !!commit &&
    graph?.head === sha &&
    !isCommitReachableFromRemote(graph, sha);

  const hasOtherSelected = !!selectedCommit && selectedCommit !== sha;

  const top: MenuItem[] = [
    { label: "Review all changes", icon: <FileTextIcon className="h-4 w-4" />, onClick: () => { close(); openStackedReview(sha, `Reviewing ${shortSha}`); } },
    { label: "Checkout commit", icon: <CheckIcon className="h-4 w-4" />, onClick: () => act(() => checkoutDetached(sha)) },
  ];

  const groups: MenuItem[] = [
    {
      label: "Compare",
      icon: <CompareIcon className="h-4 w-4" />,
      submenu: [
        { label: "With working tree", onClick: () => { close(); void openCompare({ base: sha, head: null, baseLabel: shortSha, headLabel: "Working tree", scope: "working", title: `Comparing ${shortSha} with the working tree` }); } },
        {
          label: hasOtherSelected ? `With ${selectedCommit!.slice(0, 7)}` : "With selected commit…",
          onClick: () => {
            close();
            if (hasOtherSelected) {
              void openCompare({ base: selectedCommit!, head: sha, baseLabel: selectedCommit!.slice(0, 7), headLabel: shortSha, scope: "commit", title: `Comparing ${shortSha} with ${selectedCommit!.slice(0, 7)}` });
            } else {
              requestPrompt({ title: `Compare ${shortSha} with…`, message: "Another commit-ish to compare against (it becomes the base).", placeholder: "HEAD~1, a branch, or a SHA", confirmLabel: "Compare", onSubmit: (other) => { const base = other.trim(); if (!base) return; void openCompare({ base, head: sha, baseLabel: base.length > 12 ? base.slice(0, 7) : base, headLabel: shortSha, scope: "commit", title: `Comparing ${shortSha} with ${base}` }); } });
            }
          },
        },
      ],
    },
    {
      label: "Integrate into current",
      icon: <BranchIcon className="h-4 w-4" />,
      note: `into ${cur}`,
      submenu: [
        { label: `Merge ${shortSha}`, onClick: () => act(() => mergeInto(sha, cur)) },
        { label: `Rebase onto ${shortSha}`, onClick: () => act(async () => { if (cur !== "HEAD") await checkoutBranch(cur); return rebaseOnto(sha); }) },
        { label: "Cherry-pick", onClick: () => act(() => cherryPickCommit(sha)) },
        { label: "Revert", onClick: () => act(() => revertCommit(sha)) },
      ],
    },
    {
      label: "Create",
      icon: <PlusIcon className="h-4 w-4" />,
      submenu: [
        { label: "Branch from here…", onClick: () => openCreateBranchFrom(sha) },
        { label: "Worktree from commit…", onClick: () => promptCreateWorktree(requestPrompt, run, createWorktreeAt, sha, workdir, shortSha) },
        { label: "Tag here…", onClick: () => requestPrompt({ title: `Create tag at ${shortSha}`, placeholder: "v1.0.0", confirmLabel: "Create tag", onSubmit: (name) => void run(() => createTagAt(name, sha)) }) },
        { label: "Annotated tag here…", onClick: () => promptAnnotatedTag(requestPrompt, run, createAnnotatedTagAt, sha, shortSha) },
        { label: "Patch from commit", onClick: () => act(() => createPatchAt(sha)) },
      ],
    },
  ];

  const copy: MenuItem[] = [
    { label: "Copy commit SHA", icon: <HashIcon className="h-4 w-4" />, onClick: () => { close(); void navigator.clipboard?.writeText(sha); showToast(`Copied ${shortSha}`); } },
    {
      label: "Copy",
      icon: <CopyIcon className="h-4 w-4" />,
      submenu: [
        { label: "Subject", onClick: () => { close(); void navigator.clipboard?.writeText(subject); showToast("Copied subject"); } },
        { label: "Full message", onClick: () => { close(); const full = body ? `${subject}\n\n${body}` : subject; void navigator.clipboard?.writeText(full); showToast("Copied message"); } },
      ],
    },
  ];

  const danger: MenuItem[] = [];
  if (canRewordHead) {
    danger.push({ label: "Edit commit message…", onClick: () => requestPrompt({ title: "Edit commit message", message: `This commit has not been pushed: ${shortSha}.`, placeholder: "Subject\n\nDescription", defaultValue: fullCommitMessage(subject, body), multiline: true, confirmLabel: "Update message", onSubmit: (msg) => { const next = splitCommitMessage(msg); void run(() => amendHeadMessage(next.summary, next.description)); } }) });
  }
  danger.push({ label: `Reset ${cur} to here`, header: true, danger: true, sep: danger.length > 0 });
  danger.push({ label: "Soft — keep changes staged", indent: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${shortSha}?`, message: "Soft reset — changes are kept staged.", confirmLabel: "Reset (soft)", preview: () => repoPath ? api.previewReset(repoPath, sha, "soft") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetCurrentTo(sha, "soft")), headPrecondition: resetHeadPrecondition }) });
  danger.push({ label: "Mixed — keep changes unstaged", indent: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${shortSha}?`, message: "Mixed reset — changes are kept in the working tree, unstaged.", confirmLabel: "Reset (mixed)", preview: () => repoPath ? api.previewReset(repoPath, sha, "mixed") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetCurrentTo(sha, "mixed")), headPrecondition: resetHeadPrecondition }) });
  danger.push({ label: "Hard — discard changes", indent: true, danger: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${shortSha}?`, message: "Hard reset — all uncommitted working-tree changes will be permanently discarded.", confirmLabel: "Reset (hard)", danger: true, preview: () => repoPath ? api.previewReset(repoPath, sha, "hard") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetCurrentTo(sha, "hard")), headPrecondition: resetHeadPrecondition }) });

  const items: MenuItem[] = [...top];
  groups[0] = { ...groups[0], sep: true };
  items.push(...groups);
  copy[0] = { ...copy[0], sep: true };
  items.push(...copy);
  items.push({ label: "Danger zone", icon: <WarningIcon className="h-4 w-4" />, tone: "danger", sep: true, submenu: danger });

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={236} />;
}

export function FileContextMenu() {
  const menu = useUi((s) => s.fileMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const showToast = useUi((s) => s.showToast);
  const discardFile = useRepo((s) => s.discardFile);
  const openFileHistory = useRepo((s) => s.openFileHistory);
  const workdir = useRepo((s) => s.summary?.workdir ?? s.summary?.path ?? "");
  const changes = useRepo((s) => s.changes);
  if (!menu) return null;

  const { path, discard } = menu;
  const fileName = basename(path);
  const fileGuard = fileWriteGuard(
    [...changes.unstaged, ...changes.staged].find((file) => file.path === path),
    changes,
  );
  // Absolute path = repo root + repo-relative path (workdir has no trailing slash).
  const fullPath = workdir ? `${workdir.replace(/\/+$/, "")}/${path}` : path;

  const copy = (text: string, toast: string) => {
    close();
    void navigator.clipboard?.writeText(text);
    showToast(toast);
  };

  // Copy is the most-used action here, so it leads — a "Copy" header labels the
  // cluster so the rows don't each repeat the word + icon. The history views are
  // tucked into a History group below.
  const items: MenuItem[] = [
    { label: "Copy", header: true, icon: <CopyIcon className="h-3.5 w-3.5" /> },
    { label: "File name", onClick: () => copy(fileName, `Copied ${fileName}`) },
    { label: "Relative path", onClick: () => copy(path, "Copied relative path") },
    { label: "Full path", onClick: () => copy(fullPath, "Copied full path") },
    {
      label: "History",
      icon: <ClockIcon className="h-4 w-4" />,
      sep: true,
      submenu: [
        { label: "File history", onClick: () => { close(); void openFileHistory(path); } },
        { label: "Blame", onClick: () => { close(); void openFileHistory(path, "blame"); } },
      ],
    },
  ];

  // Discard is a working-tree op — only offered on working-changes rows.
  if (discard) {
    const { staged } = discard;
    items.push({
      label: staged ? "Unstage & discard changes" : "Discard changes",
      icon: <TrashIcon className="h-4 w-4" />,
      danger: true,
      disabled: !!fileGuard,
      disabledReason: fileGuard ?? undefined,
      sep: true,
      onClick: () =>
        requestConfirm({
          title: `Discard changes to ${fileName}?`,
          message:
            "The file's working-tree changes will be permanently reverted. This can't be undone.",
          confirmLabel: staged ? "Unstage & discard" : "Discard changes",
          danger: true,
          onConfirm: () => void discardFile(path, staged),
        }),
    });
  }

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={220} />;
}

/** Right-click menu on the uncommitted "WIP" row. Acts on the whole working
 * tree; the staged/unstaged split is read from the repo store so stage/unstage
 * only appear when there's actually something in that bucket. */
export function WipContextMenu() {
  const menu = useUi((s) => s.wipMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const openCommit = useUi((s) => s.openCommit);
  const repoPath = useRepo((s) => s.summary?.path ?? null);
  const changes = useRepo((s) => s.changes);
  const stageAll = useRepo((s) => s.stageAll);
  const unstageAll = useRepo((s) => s.unstageAll);
  const stash = useRepo((s) => s.stash);
  const discardAll = useRepo((s) => s.discardAll);
  const run = useBranchOp();
  if (!menu) return null;

  const hasStaged = changes.staged.length > 0;
  const hasUnstaged = changes.unstaged.length > 0;
  const stageAllGuard = fileWriteGuard(findGuardedFile(changes.unstaged, changes), changes);
  const unstageAllGuard = fileWriteGuard(findGuardedFile(changes.staged, changes), changes);
  const bulkGuard = guardedAdvancedWriteMessage(changes);

  const items: MenuItem[] = [
    { label: "Commit…", icon: <CheckIcon className="h-4 w-4" />, onClick: () => { close(); openCommit(); } },
  ];
  if (hasUnstaged) {
    items.push({
      label: "Stage all changes",
      icon: <PlusIcon className="h-4 w-4" />,
      sep: true,
      disabled: !!stageAllGuard,
      disabledReason: stageAllGuard ?? undefined,
      onClick: () => { close(); void stageAll(); },
    });
  }
  if (hasStaged) {
    items.push({
      label: "Unstage all changes",
      icon: <MinusIcon className="h-4 w-4" />,
      sep: !hasUnstaged,
      disabled: !!unstageAllGuard,
      disabledReason: unstageAllGuard ?? undefined,
      onClick: () => { close(); void unstageAll(); },
    });
  }
  items.push({
    label: "Stash all changes",
    icon: <StashIcon className="h-4 w-4" />,
    sep: true,
    disabled: !!bulkGuard,
    disabledReason: bulkGuard ?? undefined,
    onClick: () => { close(); void stash(); },
  });
  items.push({
    label: "Discard all changes",
    icon: <TrashIcon className="h-4 w-4" />,
    danger: true,
    disabled: !!bulkGuard,
    disabledReason: bulkGuard ?? undefined,
    sep: true,
    onClick: () =>
      void previewConfirm({
        requestConfirm,
        title: "Discard all changes?",
        message:
          "Every uncommitted change — staged, unstaged, and untracked files — will be permanently discarded. This can't be undone.",
        confirmLabel: "Discard all",
        danger: true,
        preview: () =>
          repoPath
            ? api.previewDiscardAll(repoPath)
            : Promise.reject(new Error("No repository")),
        onConfirm: () => void run(() => discardAll()),
      }),
  });

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={208} />;
}

/** Right-click menu on a tag ref (graph pill or navigator row). Tags are
 * immutable pointers, so the menu reads the tagged commit and offers the same
 * "go to / branch from this point" actions as a commit, plus copy, push, and
 * delete. Delete comes in two strengths: local-only (fetch re-imports the tag
 * while it exists on origin) and local + origin. */
export function TagContextMenu() {
  const menu = useUi((s) => s.tagMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const requestPrompt = useUi((s) => s.requestPrompt);
  const showToast = useUi((s) => s.showToast);
  const openCreateBranchFrom = useUi((s) => s.openCreateBranchFrom);
  const workdir = useRepo((s) => s.summary?.workdir ?? s.summary?.path ?? "");
  const checkoutDetached = useRepo((s) => s.checkoutDetached);
  const createWorktreeAt = useRepo((s) => s.createWorktreeAt);
  const pushTag = useRepo((s) => s.pushTag);
  const deleteTag = useRepo((s) => s.deleteTag);
  const run = useBranchOp();
  if (!menu) return null;

  const { name, sha } = menu;

  // Operate on the peeled commit `sha`, never the tag name: a branch and tag can
  // share a short name, and `git branch new <name>` then fails as ambiguous.
  // `name` stays only for labels and the default worktree path.
  const items: MenuItem[] = [
    { label: "Checkout tag (detached)", icon: <CheckIcon className="h-4 w-4" />, onClick: () => { close(); void run(() => checkoutDetached(sha)); } },
    { label: "Push tag to origin", icon: <PushIcon className="h-4 w-4" />, onClick: () => { close(); void run(() => pushTag(name)); } },
    {
      label: "Create",
      icon: <PlusIcon className="h-4 w-4" />,
      sep: true,
      submenu: [
        { label: "Branch from here…", onClick: () => openCreateBranchFrom(sha) },
        { label: "Worktree from tag…", onClick: () => promptCreateWorktree(requestPrompt, run, createWorktreeAt, sha, workdir, name) },
      ],
    },
    {
      label: "Copy tag name",
      icon: <CopyIcon className="h-4 w-4" />,
      sep: true,
      onClick: () => { close(); void navigator.clipboard?.writeText(name); showToast(`Copied ${name}`); },
    },
    {
      label: "Delete local tag",
      icon: <TrashIcon className="h-4 w-4" />,
      danger: true,
      sep: true,
      onClick: () =>
        requestConfirm({
          title: `Delete tag ${name}?`,
          message:
            "Only the local tag ref is removed. If the tag was pushed, the next fetch re-imports it from origin — use “Delete from local and origin” to remove it for good.",
          confirmLabel: "Delete local tag",
          danger: true,
          onConfirm: () => void run(() => deleteTag(name)),
        }),
    },
    {
      label: "Delete from local and origin",
      icon: <TrashIcon className="h-4 w-4" />,
      danger: true,
      onClick: () =>
        requestConfirm({
          title: `Delete tag ${name} everywhere?`,
          message:
            "The tag is deleted on origin and then locally. Other clones keep their copy until they prune, but fetch will no longer restore it here.",
          confirmLabel: "Delete from local and origin",
          danger: true,
          onConfirm: () => void run(() => deleteTag(name, true)),
        }),
    },
  ];

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={236} />;
}

/** Right-click menu on a navigator worktree row. The row's left-click is the
 * primary "switch to this worktree" action now (GL-22); this menu carries the
 * secondary actions — "Open worktree" (same switch, for discoverability), copy
 * path, and remove. The active worktree only offers "Copy path" (it's already
 * open; nothing to open/remove). */
export function WorktreeContextMenu() {
  const menu = useUi((s) => s.worktreeMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const requestPrompt = useUi((s) => s.requestPrompt);
  const showToast = useUi((s) => s.showToast);
  const summary = useRepo((s) => s.summary);
  const worktrees = useRepo((s) => s.worktrees);
  const changes = useRepo((s) => s.changes);
  const openWorktree = useRepo((s) => s.openWorktree);
  const removeWorktree = useRepo((s) => s.removeWorktree);
  const moveBranchToWorktree = useRepo((s) => s.moveBranchToWorktree);
  const run = useBranchOp();
  if (!menu) return null;

  const { path, name, isMain } = menu;
  // The live worktree entry — its branch is the handoff subject, and `locked`
  // decides whether removal needs a lock-override (`--force --force`). Normalize
  // the path compare (trailing slash) to match the handoff helpers.
  const wtEntry = worktrees.find((w) => trimTrailingSlash(w.path) === trimTrailingSlash(path));
  const wtBranch = wtEntry?.branch ?? null;
  const wtLocked = wtEntry?.locked ?? false;
  // Removing the worktree backing the open tab would delete its directory out
  // from under the app, leaving the refresh pointing at a gone path. `isMain`
  // only flags the *primary* worktree, so when the app is opened on a linked
  // worktree it isn't enough — also match the open repo's own path/workdir
  // (the shared helper does both).
  const isActiveWorktree = isActiveWorktreePath(summary, path);
  const items: MenuItem[] = [];
  // The active worktree is already open, so opening it again is a no-op; only
  // offer the switch for the others.
  if (!isActiveWorktree) {
    items.push({
      label: "Open worktree",
      icon: <FolderIcon className="h-4 w-4" />,
      onClick: () => {
        close();
        void openWorktree(path).catch((e) => showToast(String(e), "error"));
      },
    });
  }
  // Hand the worktree's branch (and its uncommitted work) off to another
  // workspace (GL-74). Only when it has a branch and a *valid* destination exists
  // (bare / prunable worktrees are filtered out) — never a dead click.
  if (wtBranch && handoffDestinationOptions(worktrees, path).length > 0) {
    const sourceChanges = isActiveWorktree
      ? changes.staged.length + changes.unstaged.length + changes.conflicted.length
      : null;
    items.push({
      label: "Hand off branch to…",
      icon: <TreeIcon className="h-4 w-4 text-[color:var(--accent)]" />,
      onClick: () =>
        promptWorktreeHandoff({
          branch: wtBranch,
          sourcePath: path,
          worktrees,
          sourceChanges,
          requestPrompt,
          requestConfirm,
          run,
          moveBranchToWorktree,
          onNoDestinations: () => showToast("No other worktree to hand off to.", "error"),
        }),
    });
  }
  items.push({
    label: "Copy path",
    icon: <CopyIcon className="h-4 w-4" />,
    sep: items.length > 0,
    onClick: () => {
      close();
      void navigator.clipboard?.writeText(path);
      showToast("Copied path");
    },
  });
  // Don't offer removal of the primary worktree (git refuses) or the one
  // currently open in the app (it'd delete the active tab's directory).
  if (!isMain && !isActiveWorktree) {
    items.push({
      label: "Remove worktree",
      icon: <TrashIcon className="h-4 w-4" />,
      danger: true,
      sep: true,
      onClick: () =>
        requestConfirm({
          title: `Remove worktree ${name}?`,
          message: `The linked worktree at ${path} will be removed. Its branch and commits are kept.${
            wtLocked ? " This worktree is locked; removing it will override the lock." : ""
          }`,
          confirmLabel: "Remove worktree",
          danger: true,
          // A locked worktree needs a forced removal (`--force --force` on the
          // backend); an ordinary one stays unforced so git's dirty check applies.
          onConfirm: () => void run(() => removeWorktree(path, wtLocked)),
        }),
    });
  }

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={200} />;
}

export function StashContextMenu() {
  const menu = useUi((s) => s.stashMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const requestPrompt = useUi((s) => s.requestPrompt);
  const showToast = useUi((s) => s.showToast);
  const openStackedReview = useUi((s) => s.openStackedReview);
  const stashes = useRepo((s) => s.stashes);
  const applyStash = useRepo((s) => s.applyStash);
  const branchFromStash = useRepo((s) => s.branchFromStash);
  const dropStash = useRepo((s) => s.dropStash);
  const run = useBranchOp();
  if (!menu) return null;

  const { index, message } = menu;
  const oid = stashes.find((s) => s.index === index)?.oid;

  const items: MenuItem[] = [
    { label: "View changes", icon: <FileTextIcon className="h-4 w-4" />, onClick: () => { close(); if (oid) openStackedReview(oid, `Stash: ${message}`); } },
    {
      label: "Apply",
      icon: <CheckIcon className="h-4 w-4" />,
      sep: true,
      submenu: [
        { label: "Apply", onClick: () => { close(); void run(() => applyStash(index, false)); } },
        { label: "Apply with index", onClick: () => { close(); void run(() => applyStash(index, false, true)); } },
        { label: "Pop (apply & drop)", onClick: () => { close(); void run(() => applyStash(index, true)); } },
        {
          label: "Apply to new branch…",
          onClick: () =>
            requestPrompt({
              title: "Apply stash to a new branch",
              message: "Branches from the stash's parent commit, then applies the stash.",
              placeholder: "new-branch-name",
              confirmLabel: "Create & apply",
              onSubmit: (branch) => void run(() => branchFromStash(index, branch)),
            }),
        },
      ],
    },
    {
      label: "Copy",
      icon: <CopyIcon className="h-4 w-4" />,
      sep: true,
      submenu: [
        { label: "Stash SHA", onClick: () => { close(); if (oid) { void navigator.clipboard?.writeText(oid); showToast(`Copied ${oid.slice(0, 7)}`); } } },
        { label: "Stash message", onClick: () => { close(); void navigator.clipboard?.writeText(message); showToast("Copied stash message"); } },
      ],
    },
    {
      label: "Drop",
      icon: <TrashIcon className="h-4 w-4" />,
      danger: true,
      sep: true,
      onClick: () =>
        requestConfirm({
          title: "Drop this stash?",
          message: `"${message}" will be permanently deleted. This can't be undone.`,
          confirmLabel: "Drop stash",
          danger: true,
          onConfirm: () => void run(() => dropStash(index)),
        }),
    },
  ];

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={240} />;
}
