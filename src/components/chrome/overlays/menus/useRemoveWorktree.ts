import type { RemoveWorktreePreview } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { openIntent, publishedRepoSession } from "@/store/repoRequests";
import { useUi } from "@/store/ui";
import { useBranchOp } from "@/components/chrome/overlays/shared";
import {
  buildRemoveWorktreeConfirm,
  type RemoveWorktreeSubject,
} from "./removeWorktreeConfirm";

/** What the caller knows about the worktree before the leased preview. */
export type RemoveWorktreeRequest = Omit<RemoveWorktreeSubject, "dirty" | "locked"> & {
  locked?: boolean;
};

// Monotonic token shared by every removal preview, mirroring `previewConfirm`'s
// guard: the newest click wins and stale preview results are discarded.
let previewToken = 0;

/** Removal of a linked worktree, shared by the worktree row menu and the branch
 * menu's Worktree submenu.
 *
 * Owns the `previewRemoveWorktree` read beside the confirm it feeds (GL-303) —
 * same rationale as `useDiscardAllChanges`: one-shot destructive preview, not
 * store domain state.
 */
export function useRemoveWorktree() {
  const requestConfirm = useUi((s) => s.requestConfirm);
  const removeWorktree = useRepo((s) => s.removeWorktree);
  const run = useBranchOp();

  return async (request: RemoveWorktreeRequest) => {
    const token = ++previewToken;
    const repoAtClick = useRepo.getState().summary?.path ?? null;
    const openIntentAtClick = openIntent.current();
    const repoSessionAtClick = publishedRepoSession.current();
    const isCurrent = () =>
      token === previewToken &&
      openIntent.isCurrent(openIntentAtClick) &&
      useRepo.getState().summary?.path === repoAtClick &&
      publishedRepoSession.isCurrent(repoSessionAtClick);

    useUi.getState().closeOverlays();

    if (!repoAtClick) {
      useUi.getState().showToast("No repository", "error");
      return;
    }

    let preview: RemoveWorktreePreview;
    try {
      preview = await useRepo.getState().previewRemoveWorktree(request.path);
    } catch (e) {
      if (!isCurrent()) return;
      useUi.getState().showToast(String(e instanceof Error ? e.message : e), "error");
      return;
    }
    if (!isCurrent()) return;

    const confirm = buildRemoveWorktreeConfirm({
      name: request.name,
      path: request.path,
      branch: preview.branch,
      head: preview.headOid,
      locked: preview.locked,
      dirty: preview.dirty,
      requiresForce: preview.requiresForce,
    });
    requestConfirm({
      title: confirm.title,
      message: confirm.message,
      details: confirm.details.length > 0 ? confirm.details : preview.details,
      warnings: confirm.warnings.length > 0 ? confirm.warnings : preview.warnings,
      confirmLabel: confirm.confirmLabel,
      danger: true,
      onConfirm: () => {
        if (!isCurrent()) return;
        void run(() => removeWorktree(request.path, preview.expectedState));
      },
    });
  };
}
