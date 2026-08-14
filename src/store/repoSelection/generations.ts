// Latest-start request ownership for the selection routes, shared across the
// action modules that open and close each other's panes.
//
// Visible path/revision/endpoint values are not sufficient ownership keys:
// same-path retries, preview -> full for one oid, and A -> B -> A can all make
// an old request's subject visible again. A monotonic generation per response
// lane plus the published repo session make those ABA cycles unambiguous.

/** File history's three independent response lanes: the revision list, the
 * per-revision diff, and blame. */
export interface FileHistoryGenerations {
  claimList: () => number;
  claimDiff: () => number;
  claimBlame: () => number;
  listGeneration: () => number;
  diffGeneration: () => number;
  blameGeneration: () => number;
  /** Drop in-flight responses on one lane — a new route invalidates the child
   * requests of the prior one without claiming those lanes itself. */
  invalidateDiff: () => void;
  invalidateBlame: () => void;
  /** Drop every in-flight file-history response (the pane is closing or being
   * replaced by another view). */
  invalidate: () => void;
}

export function createFileHistoryGenerations(): FileHistoryGenerations {
  let list = 0;
  let diff = 0;
  let blame = 0;
  return {
    claimList: () => ++list,
    claimDiff: () => ++diff,
    claimBlame: () => ++blame,
    listGeneration: () => list,
    diffGeneration: () => diff,
    blameGeneration: () => blame,
    invalidateDiff: () => {
      diff += 1;
    },
    invalidateBlame: () => {
      blame += 1;
    },
    invalidate: () => {
      list += 1;
      diff += 1;
      blame += 1;
    },
  };
}

/** Compare's two lanes: the file-list/totals read and the selected-file diff.
 * Endpoints alone are not a sufficient owner — two background refreshes can
 * target the same base/head, and two full-diff requests the same path. */
export interface CompareGenerations {
  claimList: () => number;
  claimDiff: () => number;
  listGeneration: () => number;
  diffGeneration: () => number;
  invalidateDiff: () => void;
  invalidate: () => void;
}

export function createCompareGenerations(): CompareGenerations {
  let list = 0;
  let diff = 0;
  return {
    claimList: () => ++list,
    claimDiff: () => ++diff,
    listGeneration: () => list,
    diffGeneration: () => diff,
    invalidateDiff: () => {
      diff += 1;
    },
    invalidate: () => {
      list += 1;
      diff += 1;
    },
  };
}
