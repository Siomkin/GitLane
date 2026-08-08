// The two transport helpers shared by the slices that reach a remote: the
// store-level network mutex and the per-operation account resolution. Both are
// stateless — the mutex counter lives in the store — so they are plain
// functions rather than a per-store context.

import { useAccounts } from "@/store/accounts";
import type { RepoGet, RepoSet } from "@/store/repoTypes";

// Per-operation account resolution (GL-129): each network call selects from
// the exact fetch or push URL it will contact, not one repo-wide pick.
export function authFor(remote: string | null, direction: "fetch" | "push" = "push") {
  return remote && remote !== "."
    ? useAccounts.getState().transportAuthForRemote(remote, direction)
    : null;
}

// Every network transport call (fetch/pull/push/publish/…) runs inside this
// store-level mutex. Component guards are only UX — context menus, commit-and-
// push, and other callers enter through the same actions, so the store must be
// the authority that prevents concurrent remote-ref writers. Fetch is the one
// joinable operation: its same-repo callers reuse `fetchTransport` in the
// remotes slice and never try to acquire the mutex twice.
export function trackNet<T>(set: RepoSet, get: RepoGet, work: () => Promise<T>): Promise<T> {
  if (get().netOps > 0) {
    throw new Error("Another remote operation is already in progress. Try again when it finishes.");
  }
  set((s) => ({ netOps: s.netOps + 1 }));
  // Defer the actual IPC one microtask: fetch publishes `fetchTransport` and
  // `fetchingPath` synchronously after this returns, before git starts work.
  return Promise.resolve()
    .then(work)
    .finally(() => set((s) => ({ netOps: Math.max(0, s.netOps - 1) })));
}
