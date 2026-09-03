// Shared runner for PR write actions (merge, approval, lifecycle,
// create). Wraps a store action so failures surface as an error toast; routine
// success is silent (the PR detail already refreshes). Reports whether it
// succeeded so callers can clear their own input on success.

import { useCallback, useRef, useState } from "react";
import {
  capturePrActionOwner,
  prActionOwnerIsCurrent,
} from "@/store/pullsActionOwner";
import { useUi } from "@/store/ui";

/** Component-local button keys. These select exact labels/spinners; the pulls
 * store intentionally uses coarser `PR_PENDING_ACTION` domain categories. */
export const PR_ACTION_KEY = {
  Approve: "approve",
  Close: "close",
  Ready: "ready",
  Reopen: "reopen",
} as const;

export type PrActionKey = (typeof PR_ACTION_KEY)[keyof typeof PR_ACTION_KEY];

export function useRunPrAction() {
  const showToast = useUi((s) => s.showToast);
  return useCallback(
    async (
      run: () => Promise<string>,
      ownsLocalResult: () => boolean = () => true,
    ): Promise<boolean> => {
      const owner = capturePrActionOwner();
      const ownsResult = () =>
        owner !== null && prActionOwnerIsCurrent(owner) && ownsLocalResult();
      try {
        await run();
        return ownsResult();
      } catch (e) {
        if (!ownsResult()) return false;
        showToast(e, "error");
        return false;
      }
    },
    [showToast],
  );
}

/** Local per-button pending tracking layered over `useRunPrAction`.
 *
 * The pulls store's `prPendingActions` already disables every PR write button
 * while any one is in flight (so no concurrent writes can start); this hook adds
 * *which* button to spin. `start(key, action)` marks `key` pending for the
 * lifetime of `action`, so confirm-gated writes only spin once the user
 * confirms — `start` is invoked inside `onConfirm`, not at click time. A
 * synchronous `busyRef` guards the render-lag double-click window, mirroring the
 * toolbar's network-op runner. */
export function useKeyedPrAction() {
  const run = useRunPrAction();
  const [pendingKey, setPendingKey] = useState<PrActionKey | null>(null);
  const busyRef = useRef(false);
  const start = useCallback(
    async (key: PrActionKey, action: () => Promise<string>): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setPendingKey(key);
      try {
        return await run(action);
      } finally {
        busyRef.current = false;
        setPendingKey(null);
      }
    },
    [run],
  );
  return { pendingKey, start };
}
