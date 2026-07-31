// One definition of "this PR's stack merge is in flight", for the card and its
// button. `MergeStack` not `Merge`: an ordinary single-PR merge is pending on
// the same `prNum` and would make the card announce layers it isn't landing.

import { PR_PENDING_ACTION, usePulls } from "@/store/pulls";

export function useStackMergePending(prNum: number): boolean {
  return usePulls((s) =>
    s.prPendingActions.some(
      (pending) => pending.action === PR_PENDING_ACTION.MergeStack && pending.prNum === prNum,
    ),
  );
}
