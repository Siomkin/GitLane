// Exact ownership for PR writes and their caller-visible results. A write is
// issued against one published repository session and one account binding; the
// server may still complete after either changes, but none of its follow-up
// reads, toasts, or component-local success transitions may target the new
// context.

import type { GithubAccountRef } from "@/lib/api";
import { useAccounts } from "./accounts";
import { useRepo } from "./repo";
import { publishedRepoSession } from "./repoRequests";
import { prListRequestKey } from "./pullsQueue";

export interface PrActionOwner {
  path: string;
  session: number;
  requestKey: string;
}

export interface PrActionContext {
  owner: PrActionOwner;
  account: GithubAccountRef | null;
}

/** Capture the exact repo session + account used by a PR write. */
export function capturePrActionContext(): PrActionContext | null {
  const summary = useRepo.getState().summary;
  if (!summary) return null;
  const account = useAccounts.getState().prAccountRef();
  return {
    owner: {
      path: summary.path,
      session: publishedRepoSession.current(),
      requestKey: prListRequestKey(summary.path, account),
    },
    account,
  };
}

/** Component-side capture when the account object itself is not needed. */
export function capturePrActionOwner(): PrActionOwner | null {
  return capturePrActionContext()?.owner ?? null;
}

/** Whether a write's original repo session and account binding still own UI. */
export function prActionOwnerIsCurrent(owner: PrActionOwner): boolean {
  const summary = useRepo.getState().summary;
  return (
    publishedRepoSession.isCurrent(owner.session) &&
    summary?.path === owner.path &&
    prListRequestKey(owner.path, useAccounts.getState().prAccountRef()) === owner.requestKey
  );
}
