import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  buildGraphActionSpecs,
  findOtherBranchWorktree,
  type FastForwardMoves,
  type GraphActionKind,
} from "@/lib/graphActions";
import { focusRing } from "@/lib/ui";
import { useDismiss } from "@/hooks/useDismiss";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { Backdrop, useBranchOp, useFittedMenuPosition } from "../shared";
import { previewConfirm } from "./previewConfirm";

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
  const checkoutBranch = useRepo((s) => s.checkoutBranch);
  const resetCurrentTo = useRepo((s) => s.resetCurrentTo);
  const repoPath = useRepo((s) => s.summary?.path ?? null);
  const workdir = useRepo((s) => s.summary?.workdir ?? s.summary?.path ?? "");
  const worktrees = useRepo((s) => s.worktrees);
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

  // The branch a checkout-based op must check out before running: merge/rebase/
  // reset all switch the working tree to the ref they mutate (merge via
  // `mergeInto`, the others via `checkoutBranch`). Fast-forward moves a ref in
  // place and never checks out, so it isn't listed. `to`/`from` are only local
  // in the directions where these kinds are produced, matching the specs.
  const checkoutBranchFor = (kind: GraphActionKind): string | null => {
    switch (kind) {
      case "merge-target":
      case "rebase-target":
      case "reset-target":
        return to.kind === "local" ? to.name : null;
      case "rebase-source":
      case "reset-source":
        return from.kind === "local" ? from.name : null;
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
    const heldBy = heldElsewhere
      ? worktrees.find((w) => w.path === heldElsewhere.path)?.name ?? heldElsewhere.path
      : null;
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
          Drop {from.name} onto {to.kind === "commit" ? to.shortSha : to.name}
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
