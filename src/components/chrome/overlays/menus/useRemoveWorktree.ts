import type { RemoveWorktreePreview } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useBranchOp } from "@/components/chrome/overlays/shared";
import { buildRemoveWorktreeConfirm } from "./removeWorktreeConfirm";
import { captureRepoFreshness, showStaleRepoToast } from "./previewConfirm";

/** The worktree to remove. Branch, HEAD and lock state come from the leased
 * preview, not the caller's snapshot. */
export interface RemoveWorktreeRequest {
  name: string;
  path: string;
}

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
    // The same freshness guard (and token) as every other destructive preview.
    const isCurrent = captureRepoFreshness();

    useUi.getState().closeOverlays();

    if (!useRepo.getState().summary) {
      useUi.getState().showToast("No repository", "error");
      return;
    }

    let preview: RemoveWorktreePreview;
    try {
      preview = await useRepo.getState().previewRemoveWorktree(request.path);
    } catch (e) {
      if (!isCurrent()) return;
      useUi.getState().showToast(e, "error");
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
    });
    requestConfirm({
      title: confirm.title,
      message: confirm.message,
      details: confirm.details.length > 0 ? confirm.details : preview.details,
      warnings: confirm.warnings.length > 0 ? confirm.warnings : preview.warnings,
      confirmLabel: confirm.confirmLabel,
      danger: true,
      onConfirm: () => {
        if (!isCurrent()) {
          showStaleRepoToast();
          return;
        }
        void run(() => removeWorktree(request.path, preview.expectedState));
      },
    });
  };
}
