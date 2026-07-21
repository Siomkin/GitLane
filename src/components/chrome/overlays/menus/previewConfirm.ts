import type { DestructivePreview } from "@/lib/api";
import { useRepo } from "@/store/repo";
import {
  currentOpenIntent,
  currentPublishedRepoSession,
  openIntentIsCurrent,
  publishedRepoSessionIsCurrent,
} from "@/store/repoRequests";
import { useUi, type ConfirmRequest } from "@/store/ui";

export type ConfirmFn = (req: ConfirmRequest) => void;

export type HeadPrecondition = {
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

export const previewConfirm = async <T extends DestructivePreview>({
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
  preview: () => Promise<T>;
  onConfirm: (preview: T) => void;
  headPrecondition?: HeadPrecondition;
}) => {
  // Local, disposable preview read: it only enriches this confirmation modal
  // and does not become shared repo state, so it stays at the UI boundary.
  const token = ++previewToken;
  const repoAtClick = useRepo.getState().summary?.path ?? null;
  const openIntentAtClick = currentOpenIntent();
  const repoSessionAtClick = currentPublishedRepoSession();
  const isCurrent = () =>
    token === previewToken &&
    openIntentIsCurrent(openIntentAtClick) &&
    useRepo.getState().summary?.path === repoAtClick &&
    publishedRepoSessionIsCurrent(repoSessionAtClick);
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
  const showStaleRepoToast = () =>
    useUi.getState().showToast("Repository changed; preview the action again before confirming.", "error");
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
        if (!isCurrent()) {
          showStaleRepoToast();
          return;
        }
        if (!headStillMatches()) {
          showStaleHeadToast();
          return;
        }
        onConfirm(impact);
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
