// The graph's per-worktree dirty dot: which *other* worktrees hold uncommitted
// work, so a branch checked out elsewhere (and a detached worktree pill) can say
// so without the user opening it.
//
// Deliberately not part of the worktree list. `list_worktrees` is one `git
// worktree list` on every watcher-driven refresh; dirtiness costs a `git status`
// *per worktree*, so folding it in would multiply the hot path by the number of
// checkouts — exactly the cost the worktree-removal probe was kept out of it to
// avoid (GL-296).
//
// WHEN it probes is the rest of the cost story, and it is not "on every refresh".
// A sibling worktree's dirtiness cannot change because of anything *we* did: our
// own commits, checkouts and rebases are what drive full refreshes, and none of
// them touch another checkout's working tree. Polling on refresh would therefore
// spend N `git status` calls to re-learn the same answer. The probe fires when
// something could genuinely have changed it:
//   - the worktree set changed (one appeared, disappeared, or the repo switched)
//     — always, since a new worktree has no answer yet;
//   - the window regained focus — the user was somewhere else, plausibly in that
//     worktree, and this is the moment they look at the graph again;
//   - otherwise at most once per SLOW_REPROBE_MS, as cheap insurance against an
//     external change nothing else announced.
// Every pass is fire-and-forget (never awaited, so no refresh waits on it) and
// spreads its `git status` calls MAX_CONCURRENT_PROBES at a time, so a repo with
// twenty agent worktrees can't spike the disk in one burst.
//
// Freshness is best-effort by design: the filesystem watcher only watches the
// *open* worktree, so work appearing in a sibling shows up on the next trigger
// above rather than the instant it lands.

import { api } from "@/lib/api";
import { dirtyProbeCandidates } from "@/lib/worktrees";
import { repoStillDisplayed } from "./repoGuards";
import type { RepoGet, RepoSet } from "./repoTypes";

/** Floor between two passes over an unchanged worktree set — both the periodic
 * re-probe and a forced (focus-driven) one. Alt-tabbing fires `focus` and
 * `visibilitychange` together, and a user can flick between windows; this keeps
 * that from becoming a stream of status calls. A *changed* set bypasses it —
 * that's genuinely new information rather than a re-read of the same one. */
const MIN_PROBE_INTERVAL_MS = 2_000;

/** How stale an unchanged answer may get before an ordinary refresh re-probes
 * it. Long, because a refresh is almost never evidence that a *sibling* worktree
 * moved (see the header) — this is a backstop, not the main trigger. */
const SLOW_REPROBE_MS = 30_000;

/** Statuses to run at once. The pass is fire-and-forget, so its wall time
 * doesn't matter — only its peak cost does, and a user with a directory full of
 * agent worktrees shouldn't have twenty `git status` processes contending on the
 * disk at once. */
const MAX_CONCURRENT_PROBES = 4;

let inFlight = false;
/** A probe was asked for while one was already running. The in-flight pass
 * describes the state as it was when it started, so it cannot answer for a repo
 * switch or a worktree that appeared since — without this the request would be
 * dropped and the new repo would show no dots until some later refresh. */
let rerunRequested = false;
/** When the last pass *finished*. Measuring from completion (not from its start)
 * makes the interval a real gap between passes, so a slow probe can't be
 * followed immediately by another. */
let lastProbeEndedAt = 0;
let lastKey = "";

/** Drop the module state — for tests, which would otherwise have one case's
 * probe suppress the next case's. */
export function resetWorktreeDirtyProbe(): void {
  inFlight = false;
  rerunRequested = false;
  lastProbeEndedAt = 0;
  lastKey = "";
}

/** Identity of one probe pass: which repo, and which worktrees in it. The repo
 * path is part of it so switching repos always re-probes, even when the two
 * happen to have identically-named worktrees. */
function probeKey(repoPath: string, targets: string[]): string {
  return [repoPath, ...targets].join("\n");
}

/** Run the statuses `MAX_CONCURRENT_PROBES` at a time, returning the dirty paths
 * in `paths` order. A failed probe counts as clean — the dot is an at-a-glance
 * hint, and a missing one costs nothing but a trip into the worktree. */
async function probeInBatches(paths: string[]): Promise<string[]> {
  const dirty: string[] = [];
  for (let start = 0; start < paths.length; start += MAX_CONCURRENT_PROBES) {
    const batch = paths.slice(start, start + MAX_CONCURRENT_PROBES);
    const flags = await Promise.all(
      batch.map((path) => api.worktreeIsDirty(path).catch(() => false)),
    );
    batch.forEach((path, index) => {
      if (flags[index]) dirty.push(path);
    });
  }
  return dirty;
}

/** Re-probe the other worktrees' dirtiness and publish the dirty paths.
 *
 * `force` marks a trigger that is real evidence the answer moved (the window
 * regaining focus), so it probes an unchanged set instead of waiting for
 * `SLOW_REPROBE_MS`. It still respects `MIN_PROBE_INTERVAL_MS`.
 *
 * Never throws and never blocks its caller. */
export function probeDirtyWorktrees(set: RepoSet, get: RepoGet, opts?: { force?: boolean }): void {
  const { summary, worktrees, dirtyWorktrees } = get();
  if (!summary) return;
  const targets = dirtyProbeCandidates(worktrees, summary);
  const key = probeKey(summary.path, targets);
  if (targets.length === 0) {
    lastKey = key;
    if (dirtyWorktrees.length > 0) set({ dirtyWorktrees: [] });
    return;
  }
  if (inFlight) {
    rerunRequested = true;
    return;
  }
  const sinceLast = Date.now() - lastProbeEndedAt;
  const setChanged = key !== lastKey;
  if (!setChanged && sinceLast < (opts?.force ? MIN_PROBE_INTERVAL_MS : SLOW_REPROBE_MS)) return;
  lastKey = key;
  inFlight = true;
  void probeInBatches(targets)
    .then((dirty) => {
      const live = get();
      // A repo switch mid-probe: every answer describes the repo we left.
      if (!live.summary || !repoStillDisplayed(get, summary.path)) return;
      // A worktree removed mid-probe keeps its answer out of the published set —
      // it is measured but no longer ours to describe. Answers for worktrees
      // that survived are still valid: each was measured by path.
      const stillOurs = new Set(dirtyProbeCandidates(live.worktrees, live.summary));
      const published = dirty.filter((path) => stillOurs.has(path));
      const current = live.dirtyWorktrees;
      // Same set, same array — publishing a fresh one would re-render every
      // commit row's pills for nothing.
      if (
        published.length === current.length &&
        published.every((path, index) => current[index] === path)
      ) {
        return;
      }
      set({ dirtyWorktrees: published });
    })
    .finally(() => {
      inFlight = false;
      lastProbeEndedAt = Date.now();
      if (!rerunRequested) return;
      rerunRequested = false;
      // Re-reads the store, so it probes whatever is open *now*, and forces:
      // the request it stands in for was dropped, not answered. It cannot spin —
      // the retry runs with `inFlight` false, and an unchanged set inside the
      // interval simply returns without probing.
      probeDirtyWorktrees(set, get, { force: true });
    });
}
