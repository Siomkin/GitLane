// GL-297: probe every sweep candidate for uncommitted work so the confirm can
// withhold what it cannot vouch for, instead of discovering it mid-sweep as a
// raw git refusal (or, for a clean-but-live agent worktree, not at all).

import { useEffect, useState } from "react";

import { api, type WorktreeInfo } from "@/lib/api";
import { isAgentManagedWorktree } from "@/lib/worktrees";
import { buildRemoveDetachedPlan, type DirtyProbeResults, type RemoveDetachedPlan } from "./plan";

export interface RemoveDetachedPreview {
  /** False until every probe has settled — the confirm button waits on this so
   * it can never act on a half-known target set. */
  ready: boolean;
  plan: RemoveDetachedPlan;
}

/** Probe all candidates once, in parallel, and derive the sweep plan.
 *
 * This owns a documented `api` read for the same reason `useDiscardAllChanges`
 * and `useRemoveWorktree` do: it is a destructive-preview read feeding one
 * confirm, not domain state (nothing subscribes to it). Probing here rather
 * than on the worktree list keeps a `git status` per worktree off the
 * watcher-driven refresh path — see `worktree_dirty_state` (GL-296).
 */
export function useRemoveDetachedPreview(candidates: WorktreeInfo[]): RemoveDetachedPreview {
  // `candidates` is a fresh array each render, so the effect keys on the paths
  // themselves. JSON rather than a joined string: `|` (and every other
  // delimiter) is legal in a POSIX filename, so a delimiter-based key can be
  // forged by two different target sets — which would silently reuse one set's
  // probe results for another's paths.
  const key = JSON.stringify(candidates.map((wt) => wt.path));
  const [probed, setProbed] = useState<{ key: string; results: DirtyProbeResults } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        // Agent-managed candidates are withheld on their path alone, so probing
        // them would spend a `git status` on an answer that cannot change the
        // outcome. `buildRemoveDetachedPlan` checks agent ownership before it
        // reads the probe map, so their absence here is not "unverified".
        candidates
          .filter((wt) => !isAgentManagedWorktree(wt))
          .map(async (wt) => {
            try {
              return [wt.path, await api.worktreeDirtyState(wt.path)] as const;
            } catch {
              // A failed probe is recorded as null rather than dropped: the plan
              // distinguishes "probed clean" from "could not tell", and only the
              // former is safe to bulk-remove.
              return [wt.path, null] as const;
            }
          }),
      );
      if (!cancelled) setProbed({ key, results: new Map(entries) });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Results are bound to the key they were gathered for. A re-run therefore
  // reads as *not ready* until its own probes land, instead of briefly pairing
  // the new candidate set with the previous set's results — which would let the
  // confirm act on a plan built from stale answers.
  const results = probed?.key === key ? probed.results : null;
  return {
    ready: results !== null,
    plan: buildRemoveDetachedPlan(candidates, results ?? new Map()),
  };
}
