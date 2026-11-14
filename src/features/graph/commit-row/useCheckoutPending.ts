import { useRepo } from "@/store/repo";

/** True while a checkout of any of `refs` runs in the open repository. Selects a
 * boolean so only the pill being checked out re-renders. */
export function useCheckoutPending(refs: readonly string[]): boolean {
  return useRepo((s) => {
    const ref = s.summary ? s.checkoutPending[s.summary.path] : undefined;
    return ref !== undefined && refs.includes(ref);
  });
}
