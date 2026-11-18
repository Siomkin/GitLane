// Marks the refs a write acts on as pending for as long as it runs, so their
// graph pills show a spinner. Unlike `claimCheckout` it refuses nothing.

import { checkoutKey } from "@/lib/checkoutPending";
import type { PendingRefWrite, PendingWriteRef } from "@/lib/pendingRefWrites";
import type { RepoGet, RepoSet } from "@/store/repoTypes";

let nextId = 0;

/** Run `op` with `refs` recorded as pending at `repoPath`; the entry is removed
 *  when `op` settles, whether it succeeds or throws. */
export async function withRefWrite<T>(
  set: RepoSet,
  get: RepoGet,
  repoPath: string,
  refs: readonly PendingWriteRef[],
  op: () => Promise<T>,
): Promise<T> {
  const key = checkoutKey(repoPath);
  const entry: PendingRefWrite = { id: ++nextId, refs };
  set({ refWritesPending: { ...get().refWritesPending, [key]: [...(get().refWritesPending[key] ?? []), entry] } });
  try {
    return await op();
  } finally {
    const { [key]: running = [], ...rest } = get().refWritesPending;
    const left = running.filter((e) => e.id !== entry.id);
    set({ refWritesPending: left.length ? { ...rest, [key]: left } : rest });
  }
}

/** `withRefWrite` on the open repository, for `runOp` writes: wrapping the
 *  whole `runOp` keeps the spinner up through its refresh. */
export function withActiveRefWrite<T>(
  set: RepoSet,
  get: RepoGet,
  refs: readonly PendingWriteRef[],
  op: () => Promise<T>,
): Promise<T> {
  const path = get().summary?.path;
  return path ? withRefWrite(set, get, path, refs, op) : op();
}
