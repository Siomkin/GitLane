// Classifying one refresh lane's rejection.
//
// A full refresh reads the graph, the required metadata and the working changes
// on independent lanes. Each rejection is claimed separately — rather than
// letting one `Promise.all` rejection lose the other two lanes' results — and a
// rejection caused by the repository's path vanishing is routed to the
// missing-repo state instead of the error bar (GL-108).
//
// The three passes were byte-for-byte the same shape, differing only in which
// guard says "this lane is still mine". This is that shape, once.

import type { MissingRepoState } from "@/store/repoTypes";

/** What a lane's classification concluded. `transitioned` means the missing-repo
 * handler took over: the refresh must stand down, not publish. */
export type LaneFailure =
  | { transitioned: true }
  | { transitioned: false; owns: false }
  | { transitioned: false; owns: true; error: unknown };

/** A lane whose classification did not hand over to the missing-repo state —
 * what every caller holds once it has checked `transitioned`. */
export type ClaimedLane = Extract<LaneFailure, { transitioned: false }>;

const NOT_OURS: LaneFailure = { transitioned: false, owns: false };

export async function claimLaneFailure(
  result: PromiseSettledResult<unknown>,
  path: string,
  /** True while this lane still belongs to the refresh that started it. Re-read
   * after every await — a newer request can claim the lane mid-probe, and then
   * this refresh must omit the lane and continue publishing the others. */
  isCurrent: () => boolean,
  wentMissing: (path: string, error: unknown) => Promise<MissingRepoState["kind"] | null>,
  handleMissing: (
    path: string,
    kind: MissingRepoState["kind"],
    isCurrent: () => boolean,
  ) => Promise<boolean>,
  /** Guards the missing-repo transition against a newer open intent as well. */
  intentIsCurrent: () => boolean,
): Promise<LaneFailure> {
  if (result.status !== "rejected" || !isCurrent()) return NOT_OURS;
  const missing = await wentMissing(path, result.reason);
  if (!isCurrent()) return NOT_OURS;
  if (missing) {
    const transitioned = await handleMissing(
      path,
      missing,
      () => intentIsCurrent() && isCurrent(),
    );
    if (transitioned) return { transitioned: true };
    // A newer request can claim the lane while the removed-worktree fallback
    // probes a parent path. If that made the handler stand down, resume this
    // refresh's still-current publication, omitting the lost lane.
  }
  // If the lane is still ours, retain the failure so the graph shell can finish
  // and clear its loading state; a newer open intent only suppresses the error
  // text.
  return isCurrent() ? { transitioned: false, owns: true, error: result.reason } : NOT_OURS;
}
