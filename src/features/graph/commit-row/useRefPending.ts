import { BranchKind, type RefLabel } from "@/lib/api";
import { checkoutKey, pendingMatchesLabel } from "@/lib/checkoutPending";
import { writeMatchesLabel } from "@/lib/pendingRefWrites";
import { useRepo } from "@/store/repo";

/** True while a checkout of, or a write to (delete, rename, push, tag delete),
 * any of `labels` runs in the open repository. Selects a boolean so only the
 * affected pill re-renders. */
export function useRefPending(labels: readonly RefLabel[]): boolean {
  return useRepo((s) => {
    if (!s.summary) return false;
    const key = checkoutKey(s.summary.path);
    const writes = s.refWritesPending[key];
    if (writes?.some((w) => w.refs.some((ref) => labels.some((label) => writeMatchesLabel(ref, label))))) return true;
    const pending = s.checkoutPending[key];
    if (!pending) return false;
    const hasLocalBranch = (name: string) =>
      s.branches.some((b) => b.kind === BranchKind.Local && b.name === name);
    return labels.some((label) => pendingMatchesLabel(pending, label, hasLocalBranch));
  });
}
