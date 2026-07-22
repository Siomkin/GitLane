import { useEffect, useRef, useState } from "react";
import { api, BranchKind } from "@/lib/api";
import {
  buildGraphActionSpecs,
  findOtherBranchWorktree,
  GraphTargetKind,
  type FastForwardMoves,
  type GraphActionKind,
} from "@/lib/graphActions";
import { focusRing } from "@/lib/ui";
import { worktreeName } from "@/lib/worktrees";
import { useDismiss } from "@/hooks/useDismiss";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { Backdrop, useBranchOp, useFittedMenuPosition } from "@/components/chrome/overlays/shared";
import { previewConfirm } from "./previewConfirm";
import { confirmCheckoutPrereq } from "./checkoutPrereq";
import { confirmRebase } from "./rebaseConfirm";

/** Glyph + tint for an action kind — state-free. */
const iconFor = (kind: GraphActionKind) =>
  kind.startsWith("fast-forward")
    ? { icon: "⏩", iconBg: "rgba(47,158,126,0.18)" }
    : kind.startsWith("rebase")
      ? { icon: "⤴", iconBg: "rgba(91,141,239,0.18)" }
      : kind.startsWith("reset")
        ? { icon: "⤓", iconBg: "rgba(224,98,111,0.18)" }
        : { icon: "⛙", iconBg: "rgba(47,158,126,0.18)" };

export function ActionMenu() {
  const menu = useUi((s) => s.actionMenu);
  const close = useUi((s) => s.closeOverlays);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const mergeInto = useRepo((s) => s.mergeInto);
  const fastForwardTo = useRepo((s) => s.fastForwardTo);
  const rebaseOnto = useRepo((s) => s.rebaseOnto);
  const resetBranchTo = useRepo((s) => s.resetBranchTo);
  const repoPath = useRepo((s) => s.summary?.path ?? null);
  // Null when detached — a detached HEAD always makes the checkout a real
  // branch switch, so the prerequisite confirm must show.
  const headBranch = useRepo((s) => (s.summary?.detached ? null : s.summary?.headBranch ?? null));
  const workdir = useRepo((s) => s.summary?.workdir ?? s.summary?.path ?? "");
  const worktrees = useRepo((s) => s.worktrees);
  const branches = useRepo((s) => s.branches);
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
    const branchOid = (name: string, kind: BranchKind) =>
      branches.find((branch) => branch.name === name && branch.kind === kind)?.target ?? name;
    const sourceOid = branchOid(menu.from.name, menu.from.kind);
    const targetOid = menu.to.kind === GraphTargetKind.Commit
      ? menu.to.sha
      : branchOid(menu.to.name, menu.to.kind);
    Promise.all([
      // targetToSource (moving the drop target forward) is only ever offered for
      // a remote ref dropped on a local branch — a local source moves the source,
      // so its reverse direction is never read. Skip the probe otherwise.
      menu.to.kind === GraphTargetKind.Local && menu.from.kind === BranchKind.Remote
        ? api.canFastForward(repoPath, sourceOid, targetOid)
        : Promise.resolve(false),
      menu.from.kind === BranchKind.Local
        ? api.canFastForward(repoPath, targetOid, sourceOid)
        : Promise.resolve(false),
    ])
      .then(([targetToSource, sourceToTarget]) => {
        if (alive) setFf({ targetToSource, sourceToTarget });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [branches, menu, repoPath]);

  // Anchor at the drop point, then clamp on-screen once the panel is measured.
  const pos = useFittedMenuPosition(menu?.x ?? 0, menu?.y ?? 0, panelRef, [menu, ff]);

  if (!menu) return null;

  const { from, to } = menu;

  const act = (op: () => Promise<string>) => {
    close();
    void run(op);
  };

  // Reset checks out `branch` first; when that's a real branch switch, the one
  // preview confirm covers both steps (GL-217 — no stacked prerequisite popup).
  const requestMixedReset = (branch: string, target: string, targetLabel: string) => {
    const needsCheckout = headBranch !== branch;
    void previewConfirm({
      requestConfirm,
      title: `Reset ${branch} to ${targetLabel}?`,
      message: needsCheckout
        ? `Check out branch "${branch}", then reset it to "${targetLabel}". Changes remain unstaged.`
        : "Mixed reset — changes are kept in the working tree, unstaged.",
      confirmLabel: needsCheckout ? "Check out and reset (mixed)" : "Reset (mixed)",
      preview: () =>
        repoPath
          ? // `branch` (not HEAD) is the ref being reset — it's checked out in
            // onConfirm first — so the preview must be anchored on it. GL-42 review.
            api.previewReset(repoPath, target, "mixed", branch)
          : Promise.reject(new Error("No repository")),
      onConfirm: (preview) =>
        void run(async () => {
          return resetBranchTo(branch, target, "mixed", preview);
        }),
    });
  };

  const handler = (kind: GraphActionKind): (() => void) => {
    // Read-only targets (a commit or a remote-tracking ref) can only receive the
    // dragged local branch — the source moves, the target never does. The rev is
    // a commit sha or the remote ref's name.
    if (to.kind !== GraphTargetKind.Local) {
      const rev = to.kind === GraphTargetKind.Commit ? to.sha : to.name;
      const revLabel = to.kind === GraphTargetKind.Commit ? to.shortSha : to.name;
      switch (kind) {
        case "fast-forward-source":
          return () => act(() => fastForwardTo(rev, from.name));
        case "rebase-source":
          return () =>
            confirmRebase({
              source: from.name,
              onto: revLabel,
              needsCheckout: headBranch !== from.name,
              requestConfirm,
              proceed: () =>
                act(() => rebaseOnto(from.name, rev)),
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
        // `mergeInto` checks out the target branch when it isn't HEAD — the
        // same implicit prerequisite, so it gets the same approval gate.
        return () =>
          confirmCheckoutPrereq({
            headBranch,
            branch: to.name,
            operation: `merge ${from.name} into ${to.name}`,
            confirmLabel: "Check out and merge",
            requestConfirm,
            proceed: () => act(() => mergeInto(from.name, to.name)),
          });
      case "rebase-target":
        return () =>
          confirmRebase({
            source: to.name,
            onto: from.name,
            needsCheckout: headBranch !== to.name,
            requestConfirm,
            proceed: () =>
              act(() => rebaseOnto(to.name, from.name)),
          });
      case "rebase-source":
        return () =>
          confirmRebase({
            source: from.name,
            onto: to.name,
            needsCheckout: headBranch !== from.name,
            requestConfirm,
            proceed: () =>
              act(() => rebaseOnto(from.name, to.name)),
          });
      case "reset-target":
        return () => requestMixedReset(to.name, from.name, from.name);
      case "reset-source":
        return () => requestMixedReset(from.name, to.name, to.name);
      default:
        return () => {};
    }
  };

  // The branch a checkout-based op must check out before running: merge/rebase/
  // reset all switch this working tree to the ref they mutate (merge via
  // `mergeInto`, rebase/reset via their explicit backend sources). Fast-forward
  // updates a branch in its owning worktree, or its ref when it has no owner,
  // so it does not need a checkout prerequisite here. `to`/`from` are only
  // local in the directions where these kinds are produced, matching the specs.
  const checkoutBranchFor = (kind: GraphActionKind): string | null => {
    switch (kind) {
      case "merge-target":
      case "rebase-target":
      case "reset-target":
        return to.kind === GraphTargetKind.Local ? to.name : null;
      case "rebase-source":
      case "reset-source":
        return from.kind === BranchKind.Local ? from.name : null;
      default:
        return null;
    }
  };

  const items = buildGraphActionSpecs(from, to, ff).map((spec) => {
    // Git refuses to check out a branch already checked out in another worktree,
    // so a checkout-based op would fail with a raw worktree error. Disable it up
    // front with the owning worktree named, mirroring BranchContextMenu. GL-103.
    const guarded = checkoutBranchFor(spec.kind);
    const heldElsewhere = guarded ? findOtherBranchWorktree(worktrees, guarded, workdir) : null;
    // Disambiguated name (parent/leaf on collisions) — matches the pill
    // tooltips and the navigator, where the raw leaf can name every agent
    // worktree identically.
    const heldByInfo = heldElsewhere
      ? worktrees.find((w) => w.path === heldElsewhere.path)
      : null;
    const heldBy = heldByInfo
      ? worktreeName(heldByInfo, worktrees)
      : heldElsewhere?.path ?? null;
    return {
      ...spec,
      ...iconFor(spec.kind),
      onClick: handler(spec.kind),
      disabled: !!heldElsewhere,
      disabledReason: heldElsewhere
        ? `${guarded} is checked out in worktree ${heldBy}`
        : null,
    };
  });

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
          Drop {from.name} onto {to.kind === GraphTargetKind.Commit ? to.shortSha : to.name}
        </div>
        <div className="p-1.5">
          {items.map((item) => {
            const reasonId = item.disabledReason ? `action-reason-${item.kind}` : undefined;
            return (
              <button type="button"
                key={item.label}
                role="menuitem"
                disabled={item.disabled}
                aria-label={item.disabledReason ? item.label : undefined}
                aria-describedby={reasonId}
                onClick={item.disabled ? undefined : item.onClick}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left ${focusRing} ${
                  item.disabled
                    ? "cursor-not-allowed opacity-60"
                    : "hover:bg-black/5 dark:hover:bg-white/5"
                }`}
              >
                <span
                  className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg text-sm text-neutral-700 dark:text-neutral-200"
                  style={{ background: item.iconBg }}
                >
                  {item.icon}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-[13px] font-medium text-neutral-800 dark:text-neutral-100">{item.label}</span>
                  <span id={reasonId} className="text-[11px] text-neutral-400">
                    {item.disabledReason ?? item.sub}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
