// One definition of "this PR's stack merge is in flight", for the card and its
// button. `MergeStack` not `Merge`: an ordinary single-PR merge is pending on
// the same `prNum` and would make the card announce layers it isn't landing.

import { PR_PENDING_ACTION, isPrActionPending, usePulls } from "@/store/pulls";

export function useStackMergePending(prNum: number): boolean {
  return usePulls(isPrActionPending(PR_PENDING_ACTION.MergeStack, prNum));
}
