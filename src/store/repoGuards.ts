// Store-side ownership guards over the pure request-coordination primitives in
// `repoRequests.ts`, shared by the lifecycle/refresh slices. Each takes `get`
// so the slices stay plain factories with no hidden shared closure.

import { graphRequests, publishedRepoSession, takePendingRefresh } from "./repoRequests";
import type { RequestLease } from "./requestLease";
import type { RepoGet } from "./repoTypes";

export interface RepoReadOwner {
  path: string;
  session: number;
  generation: number;
}

/** A graph response is "current" only if it owns both the latest graph
 * generation AND the displayed repo path. */
export const graphRequestIsCurrent = (get: RepoGet, generation: number, path: string) =>
  graphRequests.isCurrent(generation) && get().summary?.path === path;

/** Secondary (non-graph) reads must land on whichever repo is *currently
 * displayed*, not on a specific graph generation. An unrelated "load more" or
 * refresh bumps the graph generation while these are still in flight; tying
 * them to it would silently drop branches/worktrees/stashes/changes for the
 * repo that's still on screen (GL-20 review). Repo identity (the published
 * summary path) is the right guard — a newer open or a close changes it. */
export const repoStillDisplayed = (get: RepoGet, path: string) => get().summary?.path === path;

/** Same published repo session, including protection against same-path reopen. */
export const repoSessionIsCurrent = (get: RepoGet, path: string, session: number) =>
  publishedRepoSession.isCurrent(session) && repoStillDisplayed(get, path);

/** A secondary read still owns its result: it holds its own lane, and the repo
 * session it was issued under is still the one on screen. The lane is the only
 * thing that varies — metadata, worktrees, remotes and reflog each used to have
 * a wrapper of their own with this identical body (GL-351). */
export const readRequestIsCurrent = (get: RepoGet, lane: RequestLease, owner: RepoReadOwner) =>
  lane.isCurrent(owner.generation) && repoSessionIsCurrent(get, owner.path, owner.session);

/** Replay a re-sync deferred while `loading` was held (no-op when none queued). */
export const flushPendingRefresh = (get: RepoGet) => {
  const scope = takePendingRefresh();
  if (scope) void get().refresh({ prs: false, quiet: true, scope });
};
