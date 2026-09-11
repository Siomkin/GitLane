// Pure helpers for commit selection + squash validation. Extracted from the
// repo store so the non-trivial logic is testable in isolation (no Zustand, no
// IPC). The store calls these and applies the result.

import type { RepoGraph } from "@/lib/api";
import type { ChangeSource } from "./repoTypes/views";
import { realCommits } from "./selection/graphRows";

export { isCommitReachableFromRemote } from "./selection/graphRows";
export {
  buildSquashMessage,
  getSquashEligibility,
  validateSquashRange,
  type SquashEligibility,
} from "./selection/squash";

/** Sentinel id for the uncommitted ("WIP") row when it takes part in a commit
 * selection (shift/cmd-click from the WIP row into history). It is not an oid
 * and never reaches the backend: the store strips it out, sets `wipSelected`,
 * and turns the combined pick into a `base..working-tree` compare so the
 * uncommitted changes are folded into the merged diff. */
export const WIP_SELECTION_ID = "wip";

/** Derived fetch/inspector mode for the current commit/WIP pick. Not stored —
 *  `wipSelected` and `selectionDiff` stay the source of truth; every reader
 *  goes through this so they cannot disagree about which arm they are on.
 *  `wipSelected` is the mode bit only when there is no `workingBase`: a refresh
 *  republishes the graph tip into `selectedCommit` even for a plain WIP
 *  selection, which must still route to `working`, not `commit`. */
export const COMMIT_DIFF_ROUTE = {
  /** Commits + the WIP row: one range ending at the working tree. */
  WorkingUnion: "workingUnion",
  Selection: "selection",
  Commit: "commit",
  Working: "working",
} as const;
export type CommitDiffRouteKind = (typeof COMMIT_DIFF_ROUTE)[keyof typeof COMMIT_DIFF_ROUTE];

export type CommitDiffRoute =
  | { kind: typeof COMMIT_DIFF_ROUTE.WorkingUnion; base: string }
  | { kind: typeof COMMIT_DIFF_ROUTE.Selection; commits: string[] }
  | { kind: typeof COMMIT_DIFF_ROUTE.Commit; oid: string }
  | { kind: typeof COMMIT_DIFF_ROUTE.Working; staged: boolean };

/** The store's own selection fields, as every graph-selection reader holds them. */
export interface SelectionRouteState {
  wipSelected: boolean;
  selectedCommit: string | null;
  selectedCommits: string[];
  selectionDiff: { commits: string[]; workingBase?: string | null } | null;
}

/** The route for the current graph selection. Owns the input assembly too — the
 * multi-commit fallback matters while `selectionDiff` is still loading, and
 * readers that rebuilt it themselves could disagree about which arm they were
 * on, which is the disagreement `commitDiffRoute` exists to prevent. */
export function commitDiffRouteFromRepo(state: SelectionRouteState): CommitDiffRoute {
  return commitDiffRoute({
    source: "commit",
    wipSelected: state.wipSelected,
    selectedCommit: state.selectedCommit,
    selectionDiff:
      state.selectionDiff ??
      (state.selectedCommits.length > 1 ? { commits: state.selectedCommits } : null),
  });
}

export function commitDiffRoute({
  source,
  wipSelected,
  selectedCommit,
  selectionDiff,
}: {
  source: ChangeSource;
  wipSelected: boolean;
  selectedCommit: string | null;
  selectionDiff: { commits: string[]; workingBase?: string | null } | null;
}): CommitDiffRoute {
  if (source === "commit") {
    const workingBase = selectionDiff?.workingBase ?? null;
    if (workingBase) return { kind: COMMIT_DIFF_ROUTE.WorkingUnion, base: workingBase };
    if (wipSelected) return { kind: COMMIT_DIFF_ROUTE.Working, staged: false };
    if (selectionDiff) return { kind: COMMIT_DIFF_ROUTE.Selection, commits: selectionDiff.commits };
    if (selectedCommit) return { kind: COMMIT_DIFF_ROUTE.Commit, oid: selectedCommit };
  }
  return { kind: COMMIT_DIFF_ROUTE.Working, staged: source === "staged" };
}

export function sameCommitDiffRoute(a: CommitDiffRoute, b: CommitDiffRoute): boolean {
  switch (a.kind) {
    case COMMIT_DIFF_ROUTE.WorkingUnion:
      return b.kind === COMMIT_DIFF_ROUTE.WorkingUnion && a.base === b.base;
    case COMMIT_DIFF_ROUTE.Selection:
      return (
        b.kind === COMMIT_DIFF_ROUTE.Selection &&
        a.commits.length === b.commits.length &&
        a.commits.every((oid, i) => oid === b.commits[i])
      );
    case COMMIT_DIFF_ROUTE.Commit:
      return b.kind === COMMIT_DIFF_ROUTE.Commit && a.oid === b.oid;
    case COMMIT_DIFF_ROUTE.Working:
      return b.kind === COMMIT_DIFF_ROUTE.Working && a.staged === b.staged;
  }
}

export interface SelectionInput {
  /** Commit ids in graph/display order (newest first). */
  ids: string[];
  /** Currently selected commit ids. */
  selected: string[];
  /** Current range anchor, or null. */
  anchor: string | null;
}

export interface SelectionResult {
  selected: string[];
  anchor: string | null;
  /** Focus/primary commit (drives the right panel), or null when empty. */
  focus: string | null;
}

export interface CommitBatchPlan {
  /** Graph/display order, newest first. */
  ordered: string[];
  /** Git cherry-pick order, oldest first. */
  cherryPickOrder: string[];
  /** Git revert order, newest first, so dependent commits are undone safely. */
  revertOrder: string[];
  /** Includes the oldest selected commit by diffing its first parent to newest. */
  compareRange: { base: string; head: string } | null;
  /**
   * True when the selection holds both merge and ordinary commits. `git
   * cherry-pick`/`git revert` take `-m 1` only when every named commit is a
   * merge, so such a batch cannot be one invocation and the backend refuses
   * it. Offering it here would just surface that error after the click.
   */
  mixedMergeness: boolean;
}



/**
 * Resolve the next selection from a click, honouring modifier keys:
 * - plain click → single select (becomes the anchor),
 * - additive (cmd/ctrl) → toggle the commit in/out,
 * - shift → contiguous slice from the anchor to `id` (ids are display order).
 * The focus follows the click when adding and stays put when removing.
 */
export function computeSelection(
  input: SelectionInput,
  id: string,
  mods?: { shift?: boolean; additive?: boolean },
): SelectionResult {
  const { ids, selected: prev, anchor: prevAnchor } = input;
  const shift = !!mods?.shift;
  const additive = !!mods?.additive;

  let selected: string[];
  let anchor = prevAnchor;
  if (shift && anchor && ids.includes(anchor) && ids.includes(id)) {
    const a = ids.indexOf(anchor);
    const b = ids.indexOf(id);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    selected = ids.slice(lo, hi + 1);
  } else if (additive) {
    if (prev.includes(id)) {
      const next = prev.filter((x) => x !== id);
      selected = next.length > 0 ? next : [];
    } else {
      selected = [...prev, id];
    }
    // The focus follows the click only when adding; removing leaves it.
  } else {
    selected = [id];
    anchor = id;
  }

  // The focus commit drives the right-panel file list. With an empty selection
  // (everything toggled off in additive mode) fall back to null.
  const wasInPrev = prev.includes(id);
  const isInNext = selected.includes(id);
  const focus =
    selected.length === 0
      ? null
      : additive && wasInPrev && !isInNext
        ? selected[selected.length - 1]
        : additive && !wasInPrev
          ? id
          : isInNext
            ? id
            : selected[selected.length - 1];

  return { selected, anchor, focus };
}

/** Right-click preserves a multi-selection only when the clicked row belongs to
 * it; otherwise the context menu must act on the clicked commit alone. */
export function selectionForContextMenu(selected: string[], clicked: string): string[] {
  return selected.includes(clicked) ? selected : [clicked];
}

/** Derive operation order and an inclusive compare range for a commit
 * multi-selection. Compare is only offered for a contiguous selection with a
 * first parent for the oldest commit; otherwise a tree range would include
 * commits the user did not select or omit the root commit's changes. */
export function buildCommitBatchPlan(
  graph: RepoGraph | null,
  selection: string[],
): CommitBatchPlan {
  const rows = realCommits(graph);
  const selected = new Set(selection);
  const ordered = rows.length > 0
    ? rows.filter((commit) => selected.has(commit.id)).map((commit) => commit.id)
    : [...selection];

  const indices = ordered
    .map((id) => rows.findIndex((commit) => commit.id === id))
    .filter((index) => index >= 0);
  const contiguousRows =
    rows.length > 0 &&
    ordered.length === selection.length &&
    indices.every((index, i) => i === 0 || index === indices[i - 1] + 1);
  const firstParentChain = ordered.every((id, index) => {
    const nextOlder = ordered[index + 1];
    if (!nextOlder) return true;
    return rows.find((commit) => commit.id === id)?.parents[0] === nextOlder;
  });
  const newest = ordered[0];
  const oldest = ordered[ordered.length - 1];
  const oldestCommit = rows.find((commit) => commit.id === oldest);
  const base = oldestCommit?.parents[0];

  const mergeness = ordered.map(
    (id) => (rows.find((commit) => commit.id === id)?.parents.length ?? 1) > 1,
  );

  return {
    ordered,
    cherryPickOrder: [...ordered].reverse(),
    revertOrder: [...ordered],
    compareRange:
      contiguousRows && firstParentChain && newest && base
        ? { base, head: newest }
        : null,
    mixedMergeness: mergeness.some((isMerge) => isMerge !== mergeness[0]),
  };
}

/** The base for a "selected commits + still-uncommitted work" diff, or null when
 * the pick can't express one.
 *
 * Unlike the committed union — which is exactly the picked commits, gaps and all
 * (`selection_diff` composes it) — this is a plain **range** ending at the
 * working tree: `base..worktree`. A range cannot skip rows, so any commit
 * *between* the oldest and newest pick is part of it whether or not it was
 * selected; `spanned` reports how many commits the range really covers so the
 * inspector can say so rather than under-report.
 *
 * The one hard requirement is that the newest selected commit is HEAD. Without
 * it the range would also swallow every commit above the pick — changes the user
 * neither selected nor can see in the header — which is a different diff than
 * the one they asked for, not merely a wider label.
 */
export function workingRange(
  graph: RepoGraph | null,
  selection: string[],
): { base: string; spanned: number } | null {
  const head = graph?.head;
  if (!head || selection.length === 0 || !selection.includes(head)) return null;
  const byId = new Map(realCommits(graph).map((commit) => [commit.id, commit]));
  // The range is exactly HEAD's first-parent line, so walk it and place every
  // pick on it by depth. Graph *row* order can't stand in for this: a commit on
  // another lane (or reachable only through a merge's second parent) can sit
  // below HEAD in the list without being on the line the range covers, and
  // basing the diff there would compare unrelated history.
  const depth = new Map<string, number>();
  let cursor: string | undefined = head;
  while (cursor && byId.has(cursor) && !depth.has(cursor)) {
    depth.set(cursor, depth.size);
    cursor = byId.get(cursor)!.parents[0];
  }
  let deepest: string | null = null;
  for (const id of selection) {
    const at = depth.get(id);
    if (at === undefined) return null; // off the line (or past the loaded window)
    if (deepest === null || at > depth.get(deepest)!) deepest = id;
  }
  const base = deepest && byId.get(deepest)!.parents[0];
  if (!base) return null; // a root commit has no "before" to diff against
  return { base, spanned: depth.get(deepest!)! + 1 };
}
