import { RefKind, type RefLabel } from "@/lib/api";
import { remoteTrackingCheckoutCandidate } from "@/lib/remoteBranches";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useBranchRefDrag } from "@/hooks/useBranchRefDrag";
import { useBranchWorktree } from "./useBranchWorktree";
import { refPillModel } from "./refPillModel";
import { PillGlyph } from "./PillGlyph";
import { WorktreeDirtyDot } from "./WorktreeDirtyDot";

export function RefPill({ refLabel, current, targetSha }: { refLabel: RefLabel; current: boolean; targetSha: string }) {
  const openContextMenu = useUi((state) => state.openContextMenu);
  const openTagMenu = useUi((state) => state.openTagMenu);
  const checkoutBranch = useRepo((state) => state.checkoutBranch);
  const checkoutRemoteBranch = useRepo((state) => state.checkoutRemoteBranch);
  const worktree = useBranchWorktree(refLabel.name, refLabel.kind === RefKind.Branch && !current);
  const model = refPillModel(refLabel, current, worktree?.name ?? null, worktree?.dirty ?? false);
  const name = refLabel.name;
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
      className={model.className}
      title={model.title}
      style={isDropTarget ? { boxShadow: "inset 0 0 0 1.5px rgba(46,158,98,0.75)" } : undefined}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        if (!model.draggable) return;
        e.stopPropagation();
        if (refLabel.kind === RefKind.Remote) {
          const remoteCheckout = remoteTrackingCheckoutCandidate(name, useRepo.getState().branches);
          if (remoteCheckout) {
            void checkoutRemoteBranch(remoteCheckout.remote, remoteCheckout.branch).catch((err) =>
              useUi.getState().showToast(String(err), "error"),
            );
            return;
          }
        }
        void checkoutBranch(name).catch((err) =>
          useUi.getState().showToast(String(err), "error"),
        );
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (refLabel.kind === RefKind.Tag) {
          openTagMenu({ x: e.clientX, y: e.clientY, name, sha: targetSha });
          return;
        }
        if (!model.draggable) return;
        openContextMenu({ x: e.clientX, y: e.clientY, branch: name, isCurrent: current });
      }}
    >
      <PillGlyph icon={model.icon} />
      <span className="truncate">{name}</span>
      {model.dirty && <WorktreeDirtyDot />}
    </span>
  );
}
