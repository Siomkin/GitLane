// Phase 2 of opening a repository: committing to the switch.
//
// Tab placement, lifetime rotation, recents, persistence, and the one atomic
// `set` that publishes the new summary and drops the previous repo's data —
// all in a single synchronous tick, so no other load can interleave. Returns
// the ownership tokens the later phases guard their writes with.

import { repoLabel } from "@/lib/paths";
import { groupedInsertIndex, pruneTabInfo, tabInfoFromSummary } from "@/lib/tabs";
import { repoIdentityKey } from "@/lib/worktrees";
import type { RepoSummary } from "@/lib/api";
import {
  beginMetadataRequest,
  beginPublishedRepoSession,
  beginRemotesRequest,
  beginTabLifetime,
  claimPrPrefetch,
  endTabLifetime,
  ensureTabLifetime,
  graphRequests,
  requestPrPrefetch,
  worktreeRequests,
  type TabLifetimeLease,
} from "@/store/repoRequests";
import { persistRecents, persistSession, persistTabInfo, upsertRecent } from "@/store/repoSession";
import { repoDataWipe, type RepoGet, type RepoSet } from "@/store/repoTypes";
import { usePulls } from "@/store/pulls";

/** A secondary-read batch's ownership token: the repo it reads for, the
 * published session it belongs to, and its lane's generation. */
export interface ReadOwner {
  path: string;
  session: number;
  generation: number;
}

export interface PublishedSwitch {
  generation: number;
  /** The selection request this switch claimed — phase 4's commit-files read
   * checks it so a selection made during the load wins. */
  fileSelectionRequestId: number;
  openPaths: string[];
  session: number;
  metadataOwner: ReadOwner;
  worktreeOwner: ReadOwner;
  remotesOwner: ReadOwner;
  maybePrefetchPulls: () => void;
}

export function publishRepoSwitch(
  set: RepoSet,
  get: RepoGet,
  summary: RepoSummary,
  opts: { replaceTab?: string } | undefined,
  replacementOwner: TabLifetimeLease | null,
): PublishedSwitch {
  // Phase 2 — commit to the switch. Bump the generation (superseding any
  // in-flight graph request) and, in one atomic commit, publish the new summary,
  // drop the previous repo's graph/refs/changes, and raise the loading +
  // skeleton flags. The bump and this set share a synchronous tick, so no other
  // load can interleave between them.
  const generation = graphRequests.claim();
  // Tab placement: an already-open path keeps the strip as-is; `replaceTab`
  // switches that tab to the new path in place (the in-place worktree
  // switch — the tab keeps its repository identity, GL-110); otherwise the
  // new tab is inserted right after the last tab of the same repository so
  // worktrees group next to their parent repo instead of appending as an
  // unrelated sibling.
  const prevPaths = get().openPaths;
  let openPaths: string[];
  if (prevPaths.includes(summary.path)) {
    openPaths = prevPaths;
  } else if (
    replacementOwner &&
    opts?.replaceTab &&
    prevPaths.includes(opts.replaceTab)
  ) {
    openPaths = prevPaths.map((p) => (p === opts.replaceTab ? summary.path : p));
  } else {
    const at = groupedInsertIndex(prevPaths, get().tabInfoByPath, repoIdentityKey(summary));
    openPaths = [...prevPaths.slice(0, at), summary.path, ...prevPaths.slice(at)];
  }
  const addedTarget = !prevPaths.includes(summary.path);
  const replacedSource =
    replacementOwner &&
    opts?.replaceTab &&
    opts.replaceTab !== summary.path &&
    prevPaths.includes(opts.replaceTab) &&
    !openPaths.includes(opts.replaceTab)
      ? opts.replaceTab
      : null;
  // Rotate lifetimes before persistence/UI/watch side effects. Published
  // repo-session guards take over after phase 2, so ending a replaced source
  // cannot invalidate any of the destination's secondary reads.
  if (replacedSource) endTabLifetime(replacedSource);
  if (addedTarget) beginTabLifetime(summary.path);
  else ensureTabLifetime(summary.path);
  const tabInfoByPath = pruneTabInfo(
    { ...get().tabInfoByPath, [summary.path]: tabInfoFromSummary(summary) },
    openPaths,
  );
  // Record this open in the recents list (most-recent first) so the
  // onboarding screen can offer it without browsing the filesystem again.
  const recents = upsertRecent(get().recents, {
    path: summary.path,
    name: repoLabel(summary.path),
    branch: summary.headBranch,
    lastOpenedAt: Date.now(),
  });
  persistSession(openPaths, summary.path);
  persistTabInfo(tabInfoByPath);
  persistRecents(recents);
  // Rotate the displayed-session identity in the same synchronous phase-2
  // publication as the summary, including a same-path reopen.
  const session = beginPublishedRepoSession();
  // Claim one token per secondary-read batch. Each call in a lane shares
  // its token so it can land independently, while a newer same-lane load or
  // refresh suppresses every remaining completion from this batch.
  const metadataOwner = {
    path: summary.path,
    session,
    generation: beginMetadataRequest(),
  };
  const worktreeOwner = {
    path: summary.path,
    session,
    generation: worktreeRequests.claim(),
  };
  const remotesOwner = {
    path: summary.path,
    session,
    generation: beginRemotesRequest(),
  };
  const fileSelectionRequestId = get().fileSelectionRequestId + 1;
  const maybePrefetchPulls = () => {
    if (claimPrPrefetch(session)) {
      void usePulls.getState().loadPullRequests(false, true);
    }
  };
  requestPrPrefetch(session);
  set({
    ...repoDataWipe(openPaths),
    summary,
    // A successful open resolves any missing-repo state (e.g. Retry after
    // the volume re-mounted, or Locate… landing on the relocated repo).
    missingRepo: null,
    tabInfoByPath,
    recents,
    loading: true,
    graphLoading: true,
    fileSelectionRequestId,
    // Carried across the switch: transport/session bookkeeping survives a
    // repo switch by design (see repoDataWipe).
    fetchingPath: get().fetchingPath,
    netOps: get().netOps,
    sessionRestorePhase: get().sessionRestorePhase,
    initMissingRepoRunning: get().initMissingRepoRunning,
  });
  return {
    generation,
    fileSelectionRequestId,
    openPaths,
    session,
    metadataOwner,
    worktreeOwner,
    remotesOwner,
    maybePrefetchPulls,
  };
}
