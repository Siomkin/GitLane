// The legacy one-line toast API and the stranded-`index.lock` recovery it can
// offer (GL-335).
//
// The helpers take the store's own `get` rather than importing `useUi`: they
// need `showToast` and `openAccountsSettings`, and a slice reaching back into
// the store it builds would be a runtime import cycle.

import { api } from "@/lib/api";
import {
  authFailureProvider,
  classifyGitAuthFailure,
  classifyIndexLockFailure,
  friendlyGitError,
} from "@/lib/gitError";
import { useNotifications, type NotifyAction } from "@/store/notifications";
import { useRepo } from "@/store/repo";
import type { SettingsSlice } from "./settings";

/** What the recovery flow needs from the assembled store. */
type ToastHost = () => ToastSlice & Pick<SettingsSlice, "openAccountsSettings">;

export interface ToastSlice {
  /** Legacy one-line toast. Thin forwarder into the notifications store
   *  (see store/notifications.ts) — "ok" → a success toast, "error" → a
   *  persistent, scrollable error toast with `friendlyGitError` applied. New
   *  code with a title/body/actions/progress should call `useNotifications`.
   *  Optional `retry` attaches a stranded-`index.lock` recovery action (GL-335). */
  showToast: (
    message: string,
    tone?: "ok" | "error",
    options?: { retry?: () => void | Promise<void>; repoPath?: string },
  ) => void;
  dismissToast: () => void;
}

/** Attach recovery / auth actions to error toasts. Auth wins when both match
 * (an index.lock message never is an auth failure). */
function errorToastActions(
  host: ToastHost,
  message: string,
  options?: { retry?: () => void | Promise<void>; repoPath?: string },
): NotifyAction[] | undefined {
  if (classifyGitAuthFailure(message)) {
    return [
      {
        label: "Fix authentication…",
        onClick: () => host().openAccountsSettings(authFailureProvider(message) ?? undefined),
      },
    ];
  }
  if (classifyIndexLockFailure(message) && options?.retry && options.repoPath) {
    const { retry, repoPath } = options;
    return [
      {
        label: "Remove lock & retry",
        onClick: () => {
          void removeIndexLockAndRetry(host, repoPath, retry);
        },
      },
    ];
  }
  return undefined;
}

/** True once the user has moved on to another repo — recovery must not act on
 * a path that is no longer the open repo. Toasts why and stops the caller. */
function repoClosedDuringRecovery(host: ToastHost, repoPath: string, why: string): boolean {
  if (useRepo.getState().summary?.path === repoPath) return false;
  host().showToast(why, "error");
  return true;
}

const REPO_CLOSED = "That repository is no longer open. Switch back to it, then try again.";
const REPO_CLOSED_AFTER_REMOVE =
  "Lock removed, but that repository is no longer open — switch back to retry.";

async function removeIndexLockAndRetry(
  host: ToastHost,
  repoPath: string,
  retry: () => void | Promise<void>,
): Promise<void> {
  const toastAgain = (message: string) => host().showToast(message, "error", { retry, repoPath });

  if (repoClosedDuringRecovery(host, repoPath, REPO_CLOSED)) return;
  try {
    const status = await api.inspectIndexLock(repoPath);
    if (repoClosedDuringRecovery(host, repoPath, REPO_CLOSED)) return;
    if (!status.present) {
      await retry();
      return;
    }
    if (!status.stale) {
      toastAgain(status.detail || "The index lock is still in use.");
      return;
    }
    await api.removeIndexLock(repoPath);
    if (repoClosedDuringRecovery(host, repoPath, REPO_CLOSED_AFTER_REMOVE)) return;
    await retry();
  } catch (error) {
    toastAgain(String(error));
  }
}

export function createToastSlice(host: ToastHost): ToastSlice {
  return {
    showToast: (message, tone = "ok", options = undefined) =>
      // Errors — especially multi-line hook output — persist until dismissed and
      // render scrollable/selectable; success toasts auto-clear. `friendlyGitError`
      // rewrites raw git/hook failures into readable text (no-op otherwise).
      // Transport-auth failures (missing/refused credentials, SSH publickey, 403)
      // additionally carry a one-click path to Settings → Accounts, landed on the
      // failing host's provider — every push/pull/fetch/clone surface funnels its
      // errors through here, so this is the single place that attaches it.
      // Stranded `.git/index.lock` failures (GL-335) attach "Remove lock & retry"
      // when the caller supplies a retry callback.
      void useNotifications.getState().notify(
        tone === "error"
          ? {
              kind: "error",
              title: friendlyGitError(message),
              raw: true,
              actions: errorToastActions(host, message, options),
            }
          : { kind: "success", title: message },
      ),
    dismissToast: () => {
      // Legacy single-slot API → dismiss the most recent toast (not the whole
      // stack), preserving the old "hide the current notification" meaning.
      const { toasts, dismiss } = useNotifications.getState();
      const latest = toasts[toasts.length - 1];
      if (latest) dismiss(latest.id);
    },
  };
}
