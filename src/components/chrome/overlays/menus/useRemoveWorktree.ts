import { api } from "@/lib/api";
import type { WorktreeDirtyState } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useBranchOp } from "@/components/chrome/overlays/shared";
import {
  buildRemoveWorktreeConfirm,
  type RemoveWorktreeSubject,
} from "./removeWorktreeConfirm";

/** What the caller knows about the worktree; the dirty state is probed here. */
export type RemoveWorktreeRequest = Omit<RemoveWorktreeSubject, "dirty">;

// Monotonic token shared by every removal probe, mirroring `previewConfirm`'s
// guard: the newest click wins and stale probe results are discarded.
let probeToken = 0;

/** Removal of a linked worktree, shared by the worktree row menu and the branch
 * menu's Worktree submenu.
 *
 * This hook owns a documented `api` read (the dirty probe) for the same reason
 * `useDiscardAllChanges` does: it is a destructive-preview read that belongs
 * beside the confirm it feeds, not in a store (it is a one-shot query, not
 * domain state — nothing subscribes to it).
 *
 * Why probe at all: git refuses to remove a dirty worktree, and before GL-296
 * that refusal surfaced as a raw `fatal: ... use --force to delete it` toast
 * with no way forward. Probing first lets the confirm name the work at risk and
 * carry the force through, so the user makes the call once, informed.
 */
export function useRemoveWorktree() {
  const requestConfirm = useUi((s) => s.requestConfirm);
  const removeWorktree = useRepo((s) => s.removeWorktree);
  const run = useBranchOp();

  return async (request: RemoveWorktreeRequest) => {
    // The probe is async and `confirm` is a single slot, so a second click — or a
    // repo switch — can land before an earlier probe resolves. Re-check both
    // afterwards so only the newest click, still on the same repo, opens a
    // confirm: otherwise a stale result could open a dialog whose `onConfirm`
    // removes a path against the now-active repo. Same guard as `previewConfirm`.
    const token = ++probeToken;
    const repoAtClick = useRepo.getState().summary?.path ?? null;
    const isCurrent = () =>
      token === probeToken && useRepo.getState().summary?.path === repoAtClick;

    // Close the originating menu before awaiting so a slow probe cannot
    // resurrect a confirm after the user has dismissed that menu.
    useUi.getState().closeOverlays();

    // A failed probe must never block the removal: fall back to `null`, which
    // builds the ordinary unforced confirm and lets git's own error surface if
    // the worktree turns out to be dirty. Probing is an upgrade to the warning,
    // not a precondition for acting. (`buildRemoveWorktreeConfirm` discloses the
    // unknown when a lock would force the removal regardless.)
    let dirty: WorktreeDirtyState | null = null;
    try {
      dirty = await api.worktreeDirtyState(request.path);
    } catch {
      dirty = null;
    }
    if (!isCurrent()) return;

    const confirm = buildRemoveWorktreeConfirm({ ...request, dirty });
    requestConfirm({
      title: confirm.title,
      message: confirm.message,
      details: confirm.details,
      warnings: confirm.warnings,
      confirmLabel: confirm.confirmLabel,
      danger: true,
      onConfirm: () => {
        // The repo can still change between opening the confirm and accepting
        // it; the removal must never be aimed at a different repo than the one
        // the dialog described.
        if (!isCurrent()) return;
        void run(() => removeWorktree(request.path, confirm.force));
      },
    });
  };
}
