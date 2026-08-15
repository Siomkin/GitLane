// Loading the PR list itself: the `gh`/provider read, its request-ownership
// slot, and the queued reload an account change triggers. The per-PR resource
// caches this list feeds are pruned here too, since the list defines which
// numbers still exist.

import { api, ForgeKind } from "@/lib/api";
import { summaryToPr } from "@/lib/prs";
import { useAccounts } from "@/store/accounts";
import { bumpResourceVersions, knownPrNums, pruneStalePrCaches } from "@/store/pullsCache";
import {
  cancelQueuedPrListLoad,
  mergeQueuedPrListLoad,
  prListRequestKey,
  settleQueuedPrListLoad,
} from "@/store/pullsQueue";
import {
  clearPrResources,
  currentPrListRequestKey,
  emptyPrResources,
} from "@/store/pullsResource";
import type { PullsGet, PullsSet, PullsState } from "@/store/pulls";
import { usePulls } from "@/store/pulls";
import { useRepo } from "@/store/repo";

let nextPrListRequestId = 1;

// Whether this load still owns the in-flight slot. False only after reset()
// cleared it (repo switch) and a newer load took over — in which case this load
// must not touch the shared flags. An account change does NOT reset the slot (it
// queues a reload), so ownership persists and the key check below handles it.
function prListLoadOwnsSlot(requestId: number): boolean {
  return usePulls.getState().prsRefresh?.requestId === requestId;
}


export function createPrListActions(
  set: PullsSet,
  get: PullsGet,
): Pick<PullsState, "reset" | "loadPullRequests" | "refreshPullRequests"> {
  return {
    reset: () => {
      cancelQueuedPrListLoad(get().prsRefreshQueued, new Error("PR list refresh canceled."));
      // Emptying every resource's slots orphans every in-flight per-PR request: a
      // stale settle no longer owns its slot, so it publishes nothing and can't
      // clear a fresh request's flag (GL-166). Commits rely on this too — reset
      // clears prResourceVersion, so a previous repo's still-pending request would
      // otherwise pass the version check (0 === 0) and publish into the fresh
      // state (GL-164 review).
      set({
        pullRequests: [],
        prResources: emptyPrResources(),
        prStackBadges: {},
        prStacks: {},
        prResourceVersion: {},
        prsFetchedAt: null,
        prsRefresh: null,
        prsRefreshQueued: null,
        prError: null,
        prsLoading: false,
        prPendingActions: [],
      });
    },

    // Fetch the repo's PRs via `gh`, pinned to the bound account when set.
    // Failures (gh missing, no GitHub remote, not logged in) surface as `prError`
    // and leave the list empty — never throw into the UI.
    loadPullRequests: async (force = false, quiet = false) => {
      const { summary, forge } = useRepo.getState();
      if (!summary) {
        set({ pullRequests: [], prError: null });
        return;
      }
      // Pull requests are supported for GitHub (via `gh`), GitLab (via glab /
      // REST v4, GL-140), and Bitbucket Cloud (via REST 2.0, GL-141). For any other
      // forge — or a repo with no remote — skip the provider resolution entirely
      // instead of surfacing a confusing "couldn't resolve a repository" error.
      if (
        forge &&
        forge.kind !== ForgeKind.GitHub &&
        forge.kind !== ForgeKind.GitLab &&
        forge.kind !== ForgeKind.Bitbucket
      ) {
        set({
          pullRequests: [],
          prsLoading: false,
          prError: forge.hasRemote
            ? `Pull requests aren't available for ${forge.forge ?? forge.host ?? "this remote"}.`
            : "This repository has no remote, so there are no pull requests.",
        });
        return;
      }
      const account = useAccounts.getState().prAccountRef();
      const path = summary.path;
      const key = prListRequestKey(path, account);
      if (get().prsRefresh !== null) {
        const shouldQueue = force || key !== get().prsRefresh?.key;
        const queuedPromise = shouldQueue
          ? new Promise<void>((resolve, reject) => {
              set((s) => ({
                ...(!quiet ? { prsLoading: true, prError: null } : {}),
                prsRefreshQueued: mergeQueuedPrListLoad(s.prsRefreshQueued, {
                  force,
                  quiet,
                  waiters: [{ resolve, reject, force, key }],
                }),
              }));
            })
          : undefined;
        if (!shouldQueue && !quiet) {
          set({ prsLoading: true, prError: null });
        }
        await queuedPromise;
        return;
      }
      const requestId = nextPrListRequestId++;
      set((s) => ({
        prsRefresh: { requestId, key },
        ...(quiet ? {} : { prsLoading: true }),
        prError: null,
        ...(force
          ? {
              // Every resource's cache, error, and in-flight slot cleared (the
              // same commits-slot exception as the quiet-refresh prune), so
              // per-PR spinners clear now instead of holding until the orphaned
              // request settles (GL-166).
              prResources: clearPrResources(s.prResources),
              prStacks: {},
              // Bump every known PR's version so an in-flight load (which
              // captured the old value) discards its pre-refresh write instead of
              // repopulating the just-cleared cache and making the
              // prsFetchedAt-triggered reload skip on a stale cache hit.
              prResourceVersion: bumpResourceVersions(s.prResourceVersion, knownPrNums(s)),
            }
          : {}),
      }));
      const runQueued = async () => {
        const queued = get().prsRefreshQueued;
        if (!queued) return;
        // Dequeue before awaiting, so reset() can no longer cancel this waiter.
        // Guard identity ourselves instead: settle each waiter against the current
        // repo+account so callers (mergePr/setPrState) don't run follow-up detail
        // loads against the wrong repo or under the wrong account. Per-waiter,
        // since coalescing keeps older waiters across an account/repo change.
        set({ prsRefreshQueued: null });
        try {
          await get().loadPullRequests(queued.force, queued.quiet);
          settleQueuedPrListLoad(queued, currentPrListRequestKey());
        } catch (e) {
          cancelQueuedPrListLoad(queued, e);
        }
      };
      // Release the in-flight slot without writing data — used when the response
      // is for a now-stale repo/account, so the queued reload can still run.
      const releaseSlot = () =>
        set({
          prsLoading: false,
          prsRefresh: null,
        });
      try {
        // Stack membership for the whole list in one call, so every row can carry
        // its badge — the per-PR stack read only covers an open detail. Like the
        // detail's companion read, a failure must not cost the list: `undefined`
        // (unreadable) keeps the previous badges, `[]` means no stacks exist.
        const [list, memberships] = await Promise.all([
          api.listPullRequests(path, account),
          api.repositoryStacks(path, account).catch(() => undefined),
        ]);
        // Superseded after a reset (repo switch) — a newer load owns the slot.
        if (!prListLoadOwnsSlot(requestId)) return;
        // Fetched under a now-stale repo/account (an account change queued a reload
        // under a new key): don't write account-A data as the bound account's list;
        // release the slot so the queued reload runs.
        if (currentPrListRequestKey() !== key) {
          releaseSlot();
        } else {
          const prs = list.map(summaryToPr);
          set((s) => ({
            pullRequests: prs,
            ...(memberships === undefined
              ? {}
              : { prStackBadges: Object.fromEntries(memberships.map((m) => [m.prNumber, m])) }),
            // Force already cleared the caches above; on a quiet/background refresh,
            // evict the per-PR caches for any PR whose summary changed so no tab
            // (detail/diff/checks) keeps showing stale data.
            ...(force ? {} : pruneStalePrCaches(s, prs)),
            prsLoading: false,
            prsRefresh: null,
            prsFetchedAt: Date.now(),
          }));
        }
        await runQueued();
      } catch (e) {
        if (!prListLoadOwnsSlot(requestId)) return;
        if (currentPrListRequestKey() !== key) {
          releaseSlot();
        } else if (quiet && get().prsFetchedAt != null) {
          releaseSlot();
        } else {
          set({
            pullRequests: [],
            prsLoading: false,
            prsRefresh: null,
            // Clearing the list invalidates the "last successful fetch" marker, so a
            // later quiet retry can't treat this errored/empty state as a cache to
            // preserve and silently drop the real error.
            prsFetchedAt: null,
            prError: String(e),
          });
        }
        await runQueued();
      }
    },

    // Force-refresh: drop caches and refetch the list. The detail/checks views
    // re-fetch on their own because their effects key off `prsFetchedAt`. Called
    // fire-and-forget from the panel button, so swallow the cancellation that a
    // repo switch/close raises when this forced load was queued behind a prefetch.
    refreshPullRequests: async () => {
      try {
        await get().loadPullRequests(true);
      } catch {
        /* canceled by a repo switch/close — there's nothing left to refresh */
      }
    },
  };
}
