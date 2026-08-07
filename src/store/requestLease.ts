// The frontend's most-repeated invariant, named once (GL-351): "is this async
// response still the one we want?"
//
// Nine places had hand-copied the same four lines — a module-level counter, a
// `begin…` that increments it, and an `…IsCurrent` that compares — one per lane
// of overlapping work (graph, open intent, repo session, metadata, worktrees,
// remotes, reflog, the file-diff reconcile, the commit-agent message load).
// `repoFileDiff.ts` even said so out loud: "same idiom as repoRequests.ts". An
// idiom, copied; not a module.
//
// A lease is that idiom with a name. Claim the lane before starting the work,
// then ask on settle whether you still hold it: a later claim in the same lane
// takes ownership, so the older response publishes nothing.
//
//     const graphRequests = requestLease();
//     const token = graphRequests.claim();
//     const graph = await api.commitGraph(path);
//     if (!graphRequests.isCurrent(token)) return;   // superseded mid-flight
//
// Lanes stay separate on purpose: a full refresh may supersede the working-tree
// snapshot while a still-useful metadata read completes. What a lease does *not*
// encode is identity — which repo, which account, which tab. Those are composite
// keys and owner records, and they answer a different question ("is this the
// same thing?" rather than "is this the newest?"); callers combine the two.

/** One lane of latest-claim-wins work. */
export interface RequestLease {
  /** Take the lane. The previous holder loses it immediately. */
  claim: () => number;
  /** Whether `token` still holds the lane (no newer claim since). */
  isCurrent: (token: number) => boolean;
  /** The current holder's token, without claiming. Used where a caller has to
   * notice a claim made in a window it awaited across, before the state that
   * claim will eventually publish catches up. */
  current: () => number;
}

export function requestLease(): RequestLease {
  // Tokens only ever compare for equality; the counter is just a cheap way to
  // mint one that has never been used before.
  let holder = 0;
  return {
    claim: () => ++holder,
    isCurrent: (token) => token === holder,
    current: () => holder,
  };
}
