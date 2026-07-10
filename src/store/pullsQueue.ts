// The queued PR-list load machinery (GL-161 split out of pulls.ts): while one
// list fetch is in flight, later force/foreground requests coalesce into a
// single queued re-run whose waiters are settled per-identity once it lands.
// Pure — no Zustand, no IPC. The store-glue that reads the current repo/account
// identity (`currentPrListRequestKey`) and the in-flight slot ownership
// (`prListLoadOwnsSlot`) stays in pulls.ts.

import type { GithubAccountRef } from "../lib/api";

export interface QueuedPrListLoad {
  /** force/quiet of the coalesced re-run (OR of force, AND of quiet across waiters). */
  force: boolean;
  quiet: boolean;
  waiters: PrListQueueWaiter[];
}

export interface PrListQueueWaiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  /**
   * Whether the waiter's caller awaits a force/foreground refresh. On cancellation
   * (repo switch/reset) force waiters reject so awaited callers stop; non-force
   * fire-and-forget reloads resolve quietly to avoid unhandled rejections.
   */
  force: boolean;
  /**
   * Repo + account identity this waiter requested. Tracked per-waiter (not per-
   * queue) because coalescing keeps older waiters while the queue re-runs under
   * whatever is current — a waiter whose key no longer matches must be canceled,
   * not resolved against another account's data.
   */
  key: string;
}

export function prListRequestKey(path: string, account: GithubAccountRef | null): string {
  const accountKey = account
    ? `${account.provider}:${account.host}:${account.accountId}:${account.login}`
    : "default";
  return `${path}\0${accountKey}`;
}

export function mergeQueuedPrListLoad(
  current: QueuedPrListLoad | null,
  next: QueuedPrListLoad,
): QueuedPrListLoad | null {
  if (!current) return next;
  return {
    force: current.force || next.force,
    quiet: current.quiet && next.quiet,
    waiters: [...current.waiters, ...next.waiters],
  };
}

// Settle a queued load after its re-run completed: resolve each waiter whose
// requested key still matches the current repo+account, and cancel the rest (the
// load ran under a different identity than they asked for). Per-waiter because
// coalescing keeps older waiters across an account/repo change.
export function settleQueuedPrListLoad(queued: QueuedPrListLoad | null, currentKey: string | null): void {
  queued?.waiters.forEach((waiter) => {
    if (waiter.key === currentKey) waiter.resolve();
    else if (waiter.force) waiter.reject(new Error("PR list refresh canceled."));
    else waiter.resolve();
  });
}

// Cancel a queued load (repo switch/reset/inner error): reject the awaited force
// waiters so callers like mergePr/setPrState don't run repo-dependent follow-ups,
// but resolve fire-and-forget non-force reloads so a normal navigation doesn't
// surface an unhandled promise rejection.
export function cancelQueuedPrListLoad(queued: QueuedPrListLoad | null, reason: unknown): void {
  queued?.waiters.forEach((waiter) => (waiter.force ? waiter.reject(reason) : waiter.resolve()));
}
