import { RefKind, type RefLabel } from "@/lib/api";
import { cn } from "@/lib/cn";
import { remoteTrackingCheckoutCandidate } from "@/lib/remoteBranches";
import { DROP_TARGET_RING } from "@/lib/ui";
import { useRepo } from "@/store/repo";
import { CheckoutBusyError } from "@/store/repoWriteActions/checkoutFeedback";
import { InlineSpinner } from "@/components/ui/Loading";
import { useUi, MenuKind } from "@/store/ui";
import { useBranchRefDrag } from "@/hooks/useBranchRefDrag";
import { useBranchWorktree } from "./useBranchWorktree";
import { refPillModel } from "./refPillModel";
import { PillGlyph } from "./PillGlyph";
import { WorktreeDirtyDot } from "./WorktreeDirtyDot";
import { useCheckoutPending } from "./useCheckoutPending";

/** A repeat double-click while a checkout runs is dropped silently; the
 * running checkout's spinner already answers it. */
const toastCheckoutError = (err: unknown) => {
  if (!(err instanceof CheckoutBusyError)) useUi.getState().showToast(err, "error");
};

export function RefPill({ refLabel, current, targetSha }: { refLabel: RefLabel; current: boolean; targetSha: string }) {
  const openMenu = useUi((s) => s.openMenu);
  const checkoutBranch = useRepo((state) => state.checkoutBranch);
  const checkoutRemoteBranch = useRepo((state) => state.checkoutRemoteBranch);
  const worktree = useBranchWorktree(refLabel.name, refLabel.kind === RefKind.Branch && !current);
  const model = refPillModel(refLabel, current, worktree?.name ?? null, worktree?.dirty ?? false);
  const name = refLabel.name;
  const pending = useCheckoutPending([name]);
  // The pill is nested in a droppable commit row, so stop drag events bubbling.
  const { isDropTarget, dndProps } = useBranchRefDrag(
    name,
    model.dragKind
      ? {
          draggable: true,
          kind: model.dragKind,
          // Local branches and remote-tracking refs are both drop targets:
          // dropping onto a remote ref moves the dragged local branch onto it
          // (e.g. fast-forward develop → origin/develop).
          droppable: true,
          stopPropagation: true,
        }
      : { draggable: false, stopPropagation: true },
  );

  return (
    <span
      {...dndProps}
      className={cn(model.className, isDropTarget && DROP_TARGET_RING)}
      title={model.title}
      aria-busy={pending || undefined}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        if (!model.dragKind) return;
        e.stopPropagation();
        if (refLabel.kind === RefKind.Remote) {
          const remoteCheckout = remoteTrackingCheckoutCandidate(name, useRepo.getState().branches);
          if (remoteCheckout) {
            void checkoutRemoteBranch(remoteCheckout.remote, remoteCheckout.branch).catch(toastCheckoutError);
            return;
          }
        }
        void checkoutBranch(name).catch(toastCheckoutError);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (refLabel.kind === RefKind.Tag) {
          openMenu({ kind: MenuKind.Tag, state: {
            x: e.clientX,
            y: e.clientY,
            name,
            sha: targetSha,
            // Old fixtures/backends may omit the new field. Falling back to
            // the peeled commit is fail-closed for annotated tags: the backend
            // CAS refuses it rather than deleting an unseen tag object.
            refOid: refLabel.targetOid ?? targetSha,
          } });
          return;
        }
        if (!model.dragKind) return;
        openMenu({ kind: MenuKind.Context, state: { x: e.clientX, y: e.clientY, branch: name, isCurrent: current } });
      }}
    >
      {pending ? <InlineSpinner className="h-3 w-3 shrink-0" /> : <PillGlyph icon={model.icon} />}
      <span className="truncate">{name}</span>
      {model.dirty && <WorktreeDirtyDot />}
    </span>
  );
}
