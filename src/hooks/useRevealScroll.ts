import { useEffect, useRef, useState } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import type { CommitNode } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";

interface RevealScrollParams {
  /** The commit rows currently laid out (always the full DAG — search dims
   * non-matches rather than hiding them). */
  commits: CommitNode[];
  /** Current virtual row index for each commit id after WIP/stash rows are inserted. */
  commitRowIndexById: Map<string, number>;
  /** Current virtual row index for any navigator target: commits plus synthetic
   * stash rows. */
  revealRowIndexById: Map<string, number>;
  /** Whether a search/kind-filter highlight is active right now. */
  filtering: boolean;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  /** True once TanStack Virtual has attached to the scroll element. */
  ready: boolean;
}

/**
 * Scrolls the navigator's reveal target into view inside the History list and
 * gives the landed row a one-shot highlight pulse (`flashId`). TanStack Virtual
 * owns the scroll container and positioning; this hook owns the pending reveal,
 * flash state, and cleanup timers.
 *
 * Also fires on mount, so a branch picked from another page (PRs/changes) lands
 * centred once the workspace appears. TanStack Virtual owns the scroll offset
 * and row measurement, so reveal remains correct when density or synthetic-row
 * counts change. A reveal whose tip lies past the loaded window pages in more
 * history (via `loadMoreHistory`) and re-runs until the target row exists, so
 * revealing a branch tip on a truncated graph still lands instead of toasting.
 * If a search/kind-filter highlight is active
 * when a reveal arrives, it clears it first — so the landed row reads at full
 * strength instead of dimmed — then bails; the effect re-runs once `filtering`
 * flips false and scrolls. (The row math holds regardless now that every commit
 * stays laid out, so the clear is a presentation choice, not a correctness one.)
 */
export function useRevealScroll({
  commits,
  commitRowIndexById,
  revealRowIndexById,
  filtering,
  virtualizer,
  ready,
}: RevealScrollParams) {
  const revealTarget = useRepo((state) => state.revealTarget);
  const consumeReveal = useRepo((state) => state.consumeReveal);
  const clearHistFilters = useUi((state) => state.clearHistFilters);

  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!revealTarget) return;
    // On first mount the store request can arrive one render before TanStack
    // Virtual attaches its scroll element. Keep the request pending until the
    // virtualizer is ready instead of consuming a no-op scroll.
    if (!ready || !virtualizer.scrollElement) return;
    if (filtering) {
      clearHistFilters();
      return;
    }
    const rowIndex = revealRowIndexById.get(revealTarget) ?? commitRowIndexById.get(revealTarget);
    if (rowIndex !== undefined) {
      // Defer one task so TanStack's element observers/listeners are attached
      // before the programmatic scroll fires. This matters for reveal requests
      // that already exist when HistoryWorkspace first mounts.
      revealTimer.current = setTimeout(() => {
        virtualizer.scrollToIndex(rowIndex, { align: "center" });
        setFlashId(revealTarget);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlashId(null), 760);
        consumeReveal();
      }, 0);
    } else {
      // The tip is past the loaded graph window. If more history can be paged
      // in, request the next page and keep the reveal pending — this effect
      // re-runs when the larger graph arrives (commits grows) and scrolls once
      // the target row exists. Only give up once the whole history is loaded.
      const { graph, loadingMoreHistory, loadMoreHistory } = useRepo.getState();
      if (graph?.truncated) {
        if (!loadingMoreHistory) void loadMoreHistory();
        return;
      }
      // Fully loaded and still missing (the commit isn't in this history) — say
      // so rather than silently doing nothing.
      useUi.getState().showToast("Target is outside the loaded history");
      consumeReveal();
    }
    return () => {
      if (revealTimer.current) clearTimeout(revealTimer.current);
    };
  }, [
    revealTarget,
    filtering,
    commits,
    commitRowIndexById,
    revealRowIndexById,
    virtualizer,
    ready,
    consumeReveal,
    clearHistFilters,
  ]);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      if (revealTimer.current) clearTimeout(revealTimer.current);
    },
    [],
  );

  return { flashId };
}
