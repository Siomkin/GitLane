import { useEffect, useRef, useState } from "react";
import { api, type DestructivePreview } from "@/lib/api";
import { fullCommitMessage, splitCommitMessage } from "@/lib/commitMessage";
import {
  buildGraphActionSpecs,
  findOtherBranchWorktree,
  type FastForwardMoves,
  type GraphActionKind,
} from "@/lib/graphActions";
import { focusRing } from "@/lib/ui";
import { basename } from "@/lib/paths";
import { defaultPublishTarget } from "@/lib/branchSync";
import { useDismiss } from "@/hooks/useDismiss";
import { useRepo } from "@/store/repo";
import { buildCommitBatchPlan, getSquashEligibility, isCommitReachableFromRemote } from "@/store/selection";
import { useUi, type ConfirmRequest, type PromptRequest } from "@/store/ui";
import { Backdrop, MenuPanel, useBranchOp, useFittedMenuPosition, type MenuItem } from "./shared";

type PromptFn = (req: PromptRequest) => void;
type RunFn = (op: () => Promise<string>) => void;

type ConfirmFn = (req: ConfirmRequest) => void;

const previewConfirm = async ({
  requestConfirm,
  title,
  message,
  confirmLabel,
  danger,
  preview,
  onConfirm,
}: {
  requestConfirm: ConfirmFn;
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  preview: () => Promise<DestructivePreview>;
  onConfirm: () => void;
}) => {
  // Local, disposable preview read: it only enriches this confirmation modal
  // and does not become shared repo state, so it stays at the UI boundary.
  try {
    const impact = await preview();
    requestConfirm({
      title,
      message,
      details: [impact.summary, ...impact.details],
      warnings: impact.warnings,
      confirmLabel,
      danger,
      onConfirm,
    });
  } catch (e) {
    requestConfirm({
      title,
      message,
      details: [`Could not load impact preview: ${String(e)}`],
      confirmLabel,
      danger,
      onConfirm,
    });
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
    // by sha. Only a local target can itself be moved forward (targetToSource).
    const targetRef = menu.to.kind === "commit" ? menu.to.sha : menu.to.name;
    Promise.all([
      menu.to.kind === "local"
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
          ? api.previewReset(repoPath, target, "mixed")
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
      case "reset-target":
        return () => requestMixedReset(to.name, from.name, from.name);
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
  const repoPath = useRepo((s) => s.summary?.path ?? null);
  const workdir = useRepo((s) => s.summary?.workdir ?? s.summary?.path ?? "");
  const cur = useRepo((s) => s.summary?.headBranch ?? null);
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

  const act = (op: () => Promise<string>) => {
    close();
    void run(op);
  };

  const needsPublishPrompt =
    info?.sync?.status === "noUpstream" || info?.sync?.status === "staleUpstream";
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
  const items: MenuItem[] = [];
  // Push an item, marking it the start of a new visual group (a leading
  // separator) only when something precedes it — so whichever group renders
  // first never opens with a stray divider, regardless of what's gated out.
  const add = (item: MenuItem, startsGroup = false) =>
    items.push({ ...item, sep: startsGroup && items.length > 0 });

  // ---- remote sync (local branches only) ----
  if (isLocal) {
    if (isCurrent) {
      add({ label: "Pull (fast-forward only)", onClick: () => { close(); void pull(); } }, true);
      add({
        label: "Push",
        onClick: needsPublishPrompt
          ? promptPublishBranch
          : () => {
              close();
              void push();
            },
      });
      add({
        label: "Force push (with lease)…",
        onClick: () =>
          void previewConfirm({
            requestConfirm,
            title: `Force-push ${b}?`,
            message:
              "Overwrites the remote branch with your local history (--force-with-lease: aborts if the remote moved since your last fetch). Use after amending or rebasing pushed commits.",
            confirmLabel: "Force push",
            danger: true,
            preview: () =>
              repoPath
                ? api.previewForcePush(repoPath, b)
                : Promise.reject(new Error("No repository")),
            onConfirm: () => void run(() => forcePush(b)),
          }),
      });
    } else {
      add({ label: `Push ${b}`, onClick: pushLocalBranch }, true);
    }
    add({
      label: upstream ? `Change upstream (${upstream})…` : "Set upstream…",
      onClick: () =>
        requestPrompt({
          title: `Set upstream for ${b}`,
          message: "Remote-tracking ref to track (must already exist).",
          placeholder: "origin/branch",
          defaultValue: upstream ?? `origin/${b}`,
          confirmLabel: "Set upstream",
          onSubmit: (up) => void run(() => setUpstreamFor(b, up)),
        }),
    });
  }

  // ---- integrate cur <-> branch ----
  if (!isCurrent && cur) {
    if (canFf) add({ label: `Fast-forward ${cur} to ${b}`, onClick: () => act(() => fastForwardTo(b, cur)) }, true);
    add({ label: `Merge ${b} into ${cur}`, onClick: () => act(() => mergeInto(b, cur)) }, !canFf);
    add({ label: `Rebase ${cur} onto ${b}`, onClick: () => act(async () => { await checkoutBranch(cur); return rebaseOnto(b); }) });
  }

  // ---- worktree / checkout ----
  if (existingWt) {
    add({ label: "Open worktree", onClick: () => { close(); void openWorktree(existingWt.path); } }, true);
  }
  if (!isCurrent && !existingWt) {
    add({ label: isRemote ? `Checkout ${b} (detached)` : `Checkout ${b}`, onClick: () => act(() => checkoutBranch(b)) }, !existingWt);
  }

  // ---- create from this point ----
  // `git worktree add <path> <branch>` errors if <branch> is already checked out
  // anywhere; in that case create the worktree detached at the tip instead.
  const wtCheckedOut = isCurrent || worktrees.some((w) => w.branch === b);
  const wtRef = wtCheckedOut && tip ? tip : b;
  add({ label: `Create worktree from ${b}…`, onClick: () => promptCreateWorktree(requestPrompt, run, createWorktreeAt, wtRef, workdir, b) }, true);
  add({ label: "Create branch from here…", onClick: () => openCreateBranchFrom(b) });
  if (tip && !isCurrent && cur) {
    add({ label: `Cherry-pick ${b} tip onto ${cur}`, onClick: () => act(() => cherryPickCommit(tip)) });
  }
  if (tip) {
    add({ label: `Revert ${b} tip`, onClick: () => act(() => revertCommit(tip)) });
  }

  // ---- reset (only when the branch isn't the one checked out) ----
  if (tip && cur && !isCurrent) {
    add({ label: `Reset ${cur} to ${b}`, header: true }, true);
    add({ label: "Soft — keep changes staged", indent: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${b}?`, message: "Soft reset — changes are kept staged.", confirmLabel: "Reset (soft)", preview: () => repoPath ? api.previewReset(repoPath, tip, "soft") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetCurrentTo(tip, "soft")) }) });
    add({ label: "Mixed — keep changes unstaged", indent: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${b}?`, message: "Mixed reset — changes are kept in the working tree, unstaged.", confirmLabel: "Reset (mixed)", preview: () => repoPath ? api.previewReset(repoPath, tip, "mixed") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetCurrentTo(tip, "mixed")) }) });
    add({ label: "Hard — discard changes", indent: true, danger: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${b}?`, message: "Hard reset — all uncommitted working-tree changes will be permanently discarded.", confirmLabel: "Reset (hard)", danger: true, preview: () => repoPath ? api.previewReset(repoPath, tip, "hard") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetCurrentTo(tip, "hard")) }) });
  }

  // ---- rename / delete (local branches only) ----
  if (isLocal) {
    add({
      label: `Rename ${b}…`,
      onClick: () =>
        requestPrompt({
          title: `Rename branch ${b}`,
          placeholder: "new-branch-name",
          defaultValue: b,
          confirmLabel: "Rename",
          onSubmit: (next) => {
            if (next !== b) void run(() => renameBranchTo(b, next));
          },
        }),
    }, true);
    // Skip when the branch is checked out in another worktree: `git branch -D`
    // refuses a worktree-checked-out branch (the force flag bypasses the
    // merged-safety check, not the worktree lock), so offering Delete here only
    // leads to a confusing git error. Mirrors the Checkout gating above.
    if (!isCurrent && !existingWt) {
      add({
        label: `Delete ${b}`,
        danger: true,
        onClick: () =>
          void previewConfirm({
            requestConfirm,
            title: `Delete branch ${b}?`,
            message: "The branch ref will be removed. Unmerged commits may be lost.",
            confirmLabel: "Delete branch",
            danger: true,
            preview: () =>
              repoPath
                ? api.previewDeleteBranch(repoPath, b)
                : Promise.reject(new Error("No repository")),
            onConfirm: () => void run(() => removeBranch(b, true)),
          }),
      });
    }
  }

  // ---- delete on the remote (remote-tracking refs only) ----
  // Split the ref name into remote + branch on the first slash: `origin/feat/x`
  // → remote `origin`, branch `feat/x`. Deletes the branch on the server.
  if (isRemote) {
    const slash = b.indexOf("/");
    if (slash > 0) {
      const remote = b.slice(0, slash);
      const remoteBranch = b.slice(slash + 1);
      add({
        label: `Delete ${b} on remote`,
        danger: true,
        onClick: () =>
          void previewConfirm({
            requestConfirm,
            title: `Delete ${remoteBranch} on ${remote}?`,
            message: `The branch will be deleted on the remote (${remote}). This affects everyone using it and can't be undone here.`,
            confirmLabel: "Delete on remote",
            danger: true,
            preview: () =>
              repoPath
                ? api.previewDeleteRemoteBranch(repoPath, remote, remoteBranch)
                : Promise.reject(new Error("No repository")),
            onConfirm: () => void run(() => deleteRemoteBranch(remote, remoteBranch)),
          }),
      }, true);
    }
  }

  // ---- tags ----
  if (tip) {
    add({
      label: "Create tag here…",
      onClick: () =>
        requestPrompt({
          title: `Create tag at ${tipShort}`,
          placeholder: "v1.0.0",
          confirmLabel: "Create tag",
          onSubmit: (name) => void run(() => createTagAt(name, tip)),
        }),
    }, true);
    add({
      label: "Create annotated tag here…",
      onClick: () => promptAnnotatedTag(requestPrompt, run, createAnnotatedTagAt, tip, b),
    });
  }

  // ---- copy ----
  add({
    label: "Copy branch name",
    onClick: () => {
      close();
      void navigator.clipboard?.writeText(b);
      showToast(`Copied ${b}`);
    },
  }, true);
  if (tip) {
    add({
      label: "Copy tip SHA",
      onClick: () => {
        close();
        void navigator.clipboard?.writeText(tip);
        showToast(`Copied ${tipShort}`);
      },
    });
  }

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={264} />;
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
                placeholder: "Commit message",
                defaultValue: "Squash commits",
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

  const items: MenuItem[] = [
    { label: "Review all changes", onClick: () => { close(); openStackedReview(sha, `Reviewing ${shortSha}`); } },
    ...(canRewordHead
      ? [{
          label: "Edit commit message…",
          sep: true,
          onClick: () =>
            requestPrompt({
              title: "Edit commit message",
              message: `This commit has not been pushed: ${shortSha}.`,
              placeholder: "Subject\n\nDescription",
              defaultValue: fullCommitMessage(subject, body),
              multiline: true,
              confirmLabel: "Update message",
              onSubmit: (msg) => {
                const next = splitCommitMessage(msg);
                void run(() => amendHeadMessage(next.summary, next.description));
              },
            }),
        }]
      : []),
    { label: "Checkout commit", sep: !canRewordHead, onClick: () => act(() => checkoutDetached(sha)) },
    { label: "Create worktree from this commit…", onClick: () => promptCreateWorktree(requestPrompt, run, createWorktreeAt, sha, workdir, shortSha) },
    { label: "Create branch from here…", onClick: () => openCreateBranchFrom(sha) },
    { label: "Create tag here…", onClick: () =>
      requestPrompt({
        title: `Create tag at ${shortSha}`,
        placeholder: "v1.0.0",
        confirmLabel: "Create tag",
        onSubmit: (name) => void run(() => createTagAt(name, sha)),
      }) },
    { label: "Create annotated tag here…", onClick: () => promptAnnotatedTag(requestPrompt, run, createAnnotatedTagAt, sha, shortSha) },
    { label: `Merge ${shortSha} into ${cur}`, sep: true, onClick: () => act(() => mergeInto(sha, cur)) },
    {
      label: `Rebase ${cur} onto ${shortSha}`,
      onClick: () =>
        act(async () => {
          if (cur !== "HEAD") await checkoutBranch(cur);
          return rebaseOnto(sha);
        }),
    },
    { label: `Cherry-pick onto ${cur}`, sep: true, onClick: () => act(() => cherryPickCommit(sha)) },
    { label: "Revert commit", onClick: () => act(() => revertCommit(sha)) },
    { label: "Create patch from commit", onClick: () => act(() => createPatchAt(sha)) },
    { label: `Reset ${cur} to here`, header: true, sep: true },
    { label: "Soft — keep changes staged", indent: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${shortSha}?`, message: "Soft reset — changes are kept staged.", confirmLabel: "Reset (soft)", preview: () => repoPath ? api.previewReset(repoPath, sha, "soft") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetCurrentTo(sha, "soft")) }) },
    { label: "Mixed — keep changes unstaged", indent: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${shortSha}?`, message: "Mixed reset — changes are kept in the working tree, unstaged.", confirmLabel: "Reset (mixed)", preview: () => repoPath ? api.previewReset(repoPath, sha, "mixed") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetCurrentTo(sha, "mixed")) }) },
    { label: "Hard — discard changes", indent: true, danger: true, onClick: () => void previewConfirm({ requestConfirm, title: `Reset ${cur} to ${shortSha}?`, message: "Hard reset — all uncommitted working-tree changes will be permanently discarded.", confirmLabel: "Reset (hard)", danger: true, preview: () => repoPath ? api.previewReset(repoPath, sha, "hard") : Promise.reject(new Error("No repository")), onConfirm: () => void run(() => resetCurrentTo(sha, "hard")) }) },
    {
      label: "Copy commit SHA",
      sep: true,
      onClick: () => {
        close();
        void navigator.clipboard?.writeText(sha);
        showToast(`Copied ${shortSha}`);
      },
    },
    {
      label: "Copy commit subject",
      onClick: () => {
        close();
        void navigator.clipboard?.writeText(subject);
        showToast("Copied subject");
      },
    },
    {
      label: "Copy full message",
      onClick: () => {
        close();
        const full = body ? `${subject}\n\n${body}` : subject;
        void navigator.clipboard?.writeText(full);
        showToast("Copied message");
      },
    },
  ];

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={260} />;
}

export function FileContextMenu() {
  const menu = useUi((s) => s.fileMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const showToast = useUi((s) => s.showToast);
  const discardFile = useRepo((s) => s.discardFile);
  const workdir = useRepo((s) => s.summary?.workdir ?? s.summary?.path ?? "");
  if (!menu) return null;

  const { path, discard } = menu;
  const fileName = basename(path);
  // Absolute path = repo root + repo-relative path (workdir has no trailing slash).
  const fullPath = workdir ? `${workdir.replace(/\/+$/, "")}/${path}` : path;

  const copy = (text: string, toast: string) => {
    close();
    void navigator.clipboard?.writeText(text);
    showToast(toast);
  };

  const items: MenuItem[] = [
    { label: "Copy file name", onClick: () => copy(fileName, `Copied ${fileName}`) },
    { label: "Copy relative path", onClick: () => copy(path, "Copied relative path") },
    { label: "Copy full path", onClick: () => copy(fullPath, "Copied full path") },
  ];

  // Discard is a working-tree op — only offered on working-changes rows.
  if (discard) {
    const { staged } = discard;
    items.push({
      label: staged ? "Unstage & discard changes" : "Discard changes",
      danger: true,
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

  const items: MenuItem[] = [
    { label: "Commit…", onClick: () => { close(); openCommit(); } },
  ];
  if (hasUnstaged) {
    items.push({ label: "Stage all changes", sep: true, onClick: () => { close(); void stageAll(); } });
  }
  if (hasStaged) {
    items.push({ label: "Unstage all changes", sep: !hasUnstaged, onClick: () => { close(); void unstageAll(); } });
  }
  items.push({ label: "Stash all changes", sep: true, onClick: () => { close(); void stash(); } });
  items.push({
    label: "Discard all changes",
    danger: true,
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
 * "go to / branch from this point" actions as a commit, plus a copy. Tag
 * deletion / pushing need backend commands and are intentionally absent here. */
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

  const items: MenuItem[] = [
    // Operate on the peeled commit `sha`, never the tag name: a branch and tag
    // can share a short name, and `git branch new <name>` then fails as
    // ambiguous. `name` stays only for labels and the default worktree path.
    { label: "Checkout tag (detached)", onClick: () => { close(); void run(() => checkoutDetached(sha)); } },
    { label: "Create branch from here…", onClick: () => openCreateBranchFrom(sha) },
    {
      label: "Create worktree from tag…",
      onClick: () => promptCreateWorktree(requestPrompt, run, createWorktreeAt, sha, workdir, name),
    },
    { label: "Push tag to origin", sep: true, onClick: () => { close(); void run(() => pushTag(name)); } },
    {
      label: "Delete tag",
      danger: true,
      onClick: () =>
        requestConfirm({
          title: `Delete tag ${name}?`,
          message: "The local tag ref will be removed. Any pushed copy on a remote is left untouched.",
          confirmLabel: "Delete tag",
          danger: true,
          onConfirm: () => void run(() => deleteTag(name)),
        }),
    },
    {
      label: "Copy tag name",
      sep: true,
      onClick: () => {
        close();
        void navigator.clipboard?.writeText(name);
        showToast(`Copied ${name}`);
      },
    },
  ];

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={236} />;
}

/** Right-click menu on a navigator worktree row. Opening it switches the app to
 * that worktree (loads it as a repo tab) — distinct from the row's plain click,
 * which only scrolls the current graph to the worktree's tip. Removing a
 * worktree needs a backend command and is intentionally absent here. */
export function WorktreeContextMenu() {
  const menu = useUi((s) => s.worktreeMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const showToast = useUi((s) => s.showToast);
  const workdir = useRepo((s) => s.summary?.workdir ?? null);
  const repoPath = useRepo((s) => s.summary?.path ?? null);
  const openWorktree = useRepo((s) => s.openWorktree);
  const removeWorktree = useRepo((s) => s.removeWorktree);
  const run = useBranchOp();
  if (!menu) return null;

  const { path, name, isMain } = menu;
  // Removing the worktree backing the open tab would delete its directory out
  // from under the app, leaving the refresh pointing at a gone path. `isMain`
  // only flags the *primary* worktree, so when the app is opened on a linked
  // worktree it isn't enough — also match the open repo's own path/workdir.
  const trim = (p: string) => p.replace(/\/+$/, "");
  const isActiveWorktree =
    (!!workdir && trim(path) === trim(workdir)) || (!!repoPath && trim(path) === trim(repoPath));

  const items: MenuItem[] = [
    {
      label: "Open worktree",
      onClick: () => {
        close();
        void openWorktree(path).catch((e) => showToast(String(e), "error"));
      },
    },
    {
      label: "Copy path",
      sep: true,
      onClick: () => {
        close();
        void navigator.clipboard?.writeText(path);
        showToast("Copied path");
      },
    },
  ];
  // Don't offer removal of the primary worktree (git refuses) or the one
  // currently open in the app (it'd delete the active tab's directory).
  if (!isMain && !isActiveWorktree) {
    items.push({
      label: "Remove worktree",
      danger: true,
      sep: true,
      onClick: () =>
        requestConfirm({
          title: `Remove worktree ${name}?`,
          message: `The linked worktree at ${path} will be removed. Its branch and commits are kept.`,
          confirmLabel: "Remove worktree",
          danger: true,
          onConfirm: () => void run(() => removeWorktree(path)),
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
    {
      label: "View changes",
      onClick: () => {
        close();
        if (oid) openStackedReview(oid, `Stash: ${message}`);
      },
    },
    { label: "Apply", sep: true, onClick: () => { close(); void run(() => applyStash(index, false)); } },
    { label: "Apply with index", onClick: () => { close(); void run(() => applyStash(index, false, true)); } },
    { label: "Pop (apply & drop)", onClick: () => { close(); void run(() => applyStash(index, true)); } },
    {
      label: "Apply to new branch…",
      sep: true,
      onClick: () =>
        requestPrompt({
          title: "Apply stash to a new branch",
          message: "Branches from the stash's parent commit, then applies the stash.",
          placeholder: "new-branch-name",
          confirmLabel: "Create & apply",
          onSubmit: (branch) => void run(() => branchFromStash(index, branch)),
        }),
    },
    {
      label: "Drop",
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
    {
      label: "Copy stash SHA",
      sep: true,
      onClick: () => {
        close();
        if (oid) {
          void navigator.clipboard?.writeText(oid);
          showToast(`Copied ${oid.slice(0, 7)}`);
        }
      },
    },
    {
      label: "Copy stash message",
      onClick: () => {
        close();
        void navigator.clipboard?.writeText(message);
        showToast("Copied stash message");
      },
    },
  ];

  return <MenuPanel left={menu.x} top={menu.y} items={items} onClose={close} width={240} />;
}
