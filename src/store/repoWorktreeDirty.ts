// The graph's per-worktree dirty dot: which *other* worktrees hold uncommitted
// work, so a branch checked out elsewhere (and a detached worktree pill) can say
// so without the user opening it.
//
// Deliberately not part of the worktree list. `list_worktrees` is one `git
// worktree list` on every watcher-driven refresh; dirtiness costs a `git status`
// *per worktree*, so folding it in would multiply the hot path by the number of
// checkouts — exactly the cost the worktree-removal probe was kept out of it to
// avoid (GL-296). Instead this runs after a full re-sync has already painted:
// fire-and-forget, never awaited, and throttled so a burst of filesystem events
// can't turn into a storm of status calls.
//
// Freshness is therefore best-effort by design: the filesystem watcher only
// watches the *open* worktree, so work appearing in a sibling worktree shows up
// on the next full refresh (a commit/checkout here, or — the case that matters —
// the window regaining focus after the user worked over there).

import { api } from "@/lib/api";
import { dirtyProbeCandidates } from "@/lib/worktrees";
import { repoStillDisplayed } from "./repoGuards";
import type { RepoGet, RepoSet } from "./repoTypes";

/** Shortest gap between two probes of an unchanged worktree set. A full refresh
 * can fire every 400ms during a rebase or a busy checkout; without this floor
 * each one would spend N `git status` calls to redraw the same dots. A changed
 * set (worktree added/removed, repo switched) bypasses it — that's genuinely new
 * information rather than a re-read of the same one. */
const MIN_PROBE_INTERVAL_MS = 2_000;

let inFlight = false;
let lastProbeAt = 0;
let lastKey = "";

/** Drop the throttle state — for tests, which would otherwise have one case's
 * probe suppress the next case's. */
export function resetWorktreeDirtyProbe(): void {
  inFlight = false;
  lastProbeAt = 0;
  lastKey = "";
}

/** Re-probe the other worktrees' dirtiness and publish the dirty paths.
 *
 * Never throws and never blocks its caller: a failing probe degrades to "not
 * dirty" (no dot) rather than surfacing an error, since the dot is an
 * at-a-glance hint and a missing one costs nothing but a trip into the worktree. */
export function probeDirtyWorktrees(set: RepoSet, get: RepoGet): void {
  const { summary, worktrees, dirtyWorktrees } = get();
  if (!summary) return;
  const targets = dirtyProbeCandidates(worktrees, summary);
  // The repo path is part of the key so switching repos always re-probes, even
  // when the two happen to have identically-named worktrees.
  const key = [summary.path, ...targets].join("\n");
  if (targets.length === 0) {
    lastKey = key;
    if (dirtyWorktrees.length > 0) set({ dirtyWorktrees: [] });
    return;
  }
  if (inFlight) return;
  const now = Date.now();
  if (key === lastKey && now - lastProbeAt < MIN_PROBE_INTERVAL_MS) return;
  lastKey = key;
  lastProbeAt = now;
  inFlight = true;
  // One IPC per worktree, resolved together so the dots repaint in a single
  // store update instead of flickering in one at a time.
  void Promise.all(targets.map((path) => api.worktreeIsDirty(path).catch(() => false)))
    .then((flags) => {
      // A repo switch mid-probe: the answers describe the repo we left.
      if (!repoStillDisplayed(get, summary.path)) return;
      const dirty = targets.filter((_, index) => flags[index]);
      const current = get().dirtyWorktrees;
      // Same set, same array — publishing a fresh one would re-render every
      // commit row's pills for nothing.
      if (dirty.length === current.length && dirty.every((path, i) => current[i] === path)) return;
      set({ dirtyWorktrees: dirty });
    })
    .finally(() => {
      inFlight = false;
    });
}
