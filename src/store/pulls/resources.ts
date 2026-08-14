// The lazily-loaded per-PR resources — detail (+ its stack), checks, the full
// verified commit list, the diff, and review threads. Each is one call to the
// shared loader in `pullsResource.ts`, which owns the slot/version guards; what
// lives here is only the per-resource fetch and how its result is published.

import { api } from "@/lib/api";
import { detailToPr, uiCommits } from "@/lib/prs";
import type { PullsGet, PullsSet, PullsState } from "@/store/pulls";
import {
  loadPrResource,
  omit,
  patchPrResource,
  PR_RESOURCE,
} from "@/store/pullsResource";

export function createPrResourceActions(
  set: PullsSet,
  get: PullsGet,
): Pick<
  PullsState,
  "loadPrDetail" | "loadPrChecks" | "loadPrCommits" | "loadPrDiff" | "loadPrThreads"
> {
  return {
    // Cached by number — re-opening a previously-viewed PR is instant.
    loadPrDetail: (num, force) =>
      loadPrResource(set, get, {
        kind: PR_RESOURCE.Detail,
        num,
        force,
        // The stack rides the detail request rather than owning a lazy slot of its
        // own: it is one small GraphQL read, the card renders with the PR body, and
        // it inherits the shared staleness guards instead of duplicating them. A
        // stack read that fails must not cost the user the whole PR detail.
        fetch: (path, n, account) =>
          Promise.all([
            api.pullRequestDetail(path, n, account),
            api.pullRequestStack(path, n, account).catch(() => undefined),
          ]),
        publish: (s, [detail, stack]) => ({
          prResources: patchPrResource(
            // Fresh commits (verified: false) — drop the applied marker so the
            // lazy verified-commits fetch re-runs for this PR.
            patchPrResource(s.prResources, PR_RESOURCE.Commits, {
              data: omit(s.prResources.commits.data, num),
            }),
            PR_RESOURCE.Detail,
            { data: { ...s.prResources.detail.data, [num]: detailToPr(detail) } },
          ),
          // Stacked → publish. Confirmed unstacked (null) → clear, so a stack this
          // PR left doesn't linger. Unreadable (undefined) → keep whatever was
          // there; a failed read is not evidence the stack is gone. Collapsing the
          // two let one transient GraphQL blip delete a working stack card, which —
          // with a cached detail short-circuiting the next load — never came back
          // until a forced refresh.
          prStacks:
            stack === undefined
              ? s.prStacks
              : stack === null
                ? omit(s.prStacks, num)
                : { ...s.prStacks, [num]: stack },
        }),
      }),

    // Lazily loaded (the slow statusCheckRollup) and cached by number. Unlike its
    // siblings an unforced load also skips while one is already in flight — the
    // Checks tab polls, so a slow rollup would otherwise stack up requests.
    loadPrChecks: (num, force) =>
      loadPrResource(set, get, {
        kind: PR_RESOURCE.Checks,
        num,
        force,
        skip: (s) => !!s.prResources.checks.slots[num] || num in s.prResources.checks.data,
        fetch: (path, n, account) => api.pullRequestChecks(path, n, account),
      }),

    // Lazily fetch the full, verified commit list (paginated GraphQL) and replace
    // the cached detail's capped `gh pr view` commits. Supplementary: on failure
    // keep the fast-path list rather than blanking the Commits tab.
    loadPrCommits: (num, force) => {
      // A precondition rather than a cache check — this load patches the cached
      // detail's commits, so without one there is nothing to patch even when forced.
      if (!get().prResources.detail.data[num]) return Promise.resolve();
      return loadPrResource(set, get, {
        kind: PR_RESOURCE.Commits,
        num,
        force,
        fetch: (path, n, account) => api.pullRequestCommits(path, n, account),
        publish: (s, result) => {
          const detail = s.prResources.detail.data[num];
          // The detail was evicted under us — there is nothing left to patch.
          if (!detail) return {};
          return {
            prResources: patchPrResource(
              patchPrResource(s.prResources, PR_RESOURCE.Detail, {
                data: {
                  ...s.prResources.detail.data,
                  [num]: { ...detail, commits: uiCommits(result.commits, detail.url) },
                },
              }),
              PR_RESOURCE.Commits,
              {
                data: {
                  ...s.prResources.commits.data,
                  [num]: { truncated: result.truncated },
                },
              },
            ),
          };
        },
      });
    },

    // Lazily loaded (the full `gh pr diff`, parsed server-side) and cached by number.
    loadPrDiff: (num, force) =>
      loadPrResource(set, get, {
        kind: PR_RESOURCE.Diff,
        num,
        force,
        fetch: (path, n, account) => api.pullRequestDiff(path, n, account),
      }),

    // Lazily loaded (GraphQL review threads) and cached by number.
    // The API result is structurally the payload ({ threads, truncated }), so the
    // default publish caches it whole.
    loadPrThreads: (num, force) =>
      loadPrResource(set, get, {
        kind: PR_RESOURCE.Threads,
        num,
        force,
        fetch: (path, n, account) => api.pullRequestReviewThreads(path, n, account),
      }),
  };
}
