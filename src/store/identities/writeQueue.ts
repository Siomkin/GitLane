// Serialising identity writes per repository.
//
// Applying a card is a multi-key git-config transaction; two UI entry points
// racing for one repo would interleave. Each repo key gets a tail promise every
// write chains onto, a generation so only the newest may publish, and an intent
// record so deleting a card cancels a write still queued for it.

import type { CommitSourceRef } from "@/lib/identities";
import { useAccounts } from "@/store/accounts";
import { currentPathForIdentity } from "./storage";

// Identity writes are multi-key git-config transactions on the backend. Keep
// one write in flight per repository identity so two UI entry points cannot
// interleave different cards. The generation is bumped when intent is
// captured (before queueing), which also prevents a superseded write from
// publishing stale persistence, view state, or error toasts.
export const identityWriteTails = new Map<string, Promise<void>>();
export const latestIdentityWrite = new Map<string, number>();
export const activeIdentityIntents = new Map<
  string,
  { generation: number; ref: CommitSourceRef | null }
>();
let identityWriteGeneration = 0;

export function nextIdentityWrite(key: string, ref: CommitSourceRef | null): number {
  const generation = ++identityWriteGeneration;
  latestIdentityWrite.set(key, generation);
  activeIdentityIntents.set(key, { generation, ref });
  return generation;
}

export function isLatestIdentityWrite(key: string, generation: number): boolean {
  return latestIdentityWrite.get(key) === generation;
}

export function invalidateDeletedIdentity(id: string) {
  for (const [key, intent] of activeIdentityIntents) {
    if (intent.ref?.id !== id) continue;
    latestIdentityWrite.set(key, ++identityWriteGeneration);
    // The deleted intent may be queued behind an older write that will still
    // succeed durably. Reconcile after the whole queue drains so invalidating
    // the newer intent cannot leave the in-memory commit identity stale.
    void queueIdentityWrite(key, async () => {
      const currentPath = currentPathForIdentity(key);
      if (currentPath) await useAccounts.getState().hydrateRepoIdentity(currentPath);
    }).catch(() => undefined);
  }
}

export function queueIdentityWrite<T>(key: string, write: () => Promise<T>): Promise<T> {
  const previous = identityWriteTails.get(key);
  // Preserve the store's existing immediate-dispatch contract when the queue
  // is idle: calling applyCommitSource starts the IPC before it returns. Only
  // a genuinely overlapping write is deferred behind the prior tail.
  const queued = previous
    ? previous.catch(() => undefined).then(write)
    : Promise.resolve(write());
  const tail = queued.then(
    () => undefined,
    () => undefined,
  );
  identityWriteTails.set(key, tail);
  void tail.finally(() => {
    if (identityWriteTails.get(key) === tail) identityWriteTails.delete(key);
  });
  return queued;
}
