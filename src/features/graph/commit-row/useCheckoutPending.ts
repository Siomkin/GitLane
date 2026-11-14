import { BranchKind, type RefLabel } from "@/lib/api";
import { checkoutKey, pendingMatchesLabel } from "@/lib/checkoutPending";
import { useRepo } from "@/store/repo";

/** True while a checkout of any of `labels` runs in the open repository.
 * Selects a boolean so only the pill being checked out re-renders. */
export function useCheckoutPending(labels: readonly RefLabel[]): boolean {
  return useRepo((s) => {
    const pending = s.summary ? s.checkoutPending[checkoutKey(s.summary.path)] : undefined;
    if (!pending) return false;
    const hasLocalBranch = (name: string) =>
      s.branches.some((b) => b.kind === BranchKind.Local && b.name === name);
    return labels.some((label) => pendingMatchesLabel(pending, label, hasLocalBranch));
  });
}
