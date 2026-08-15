// Pure helpers for commit selection + squash validation. Extracted from the
// repo store so the non-trivial logic is testable in isolation (no Zustand, no
// IPC). The store calls these and applies the result.

import { RefKind, type RepoGraph } from "@/lib/api";
import { fullCommitMessage } from "@/lib/commitMessage";
import type { ChangeSource } from "./repoTypes/views";

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
export type CommitDiffRoute =
  | { kind: "workingUnion"; base: string }
  | { kind: "selection"; commits: string[] }
  | { kind: "commit"; oid: string }
  | { kind: "working"; staged: boolean };

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
    if (workingBase) return { kind: "workingUnion", base: workingBase };
    if (wipSelected) return { kind: "working", staged: false };
    if (selectionDiff) return { kind: "selection", commits: selectionDiff.commits };
    if (selectedCommit) return { kind: "commit", oid: selectedCommit };
  }
  return { kind: "working", staged: source === "staged" };
}

export function sameCommitDiffRoute(a: CommitDiffRoute, b: CommitDiffRoute): boolean {
  switch (a.kind) {
    case "workingUnion":
      return b.kind === "workingUnion" && a.base === b.base;
    case "selection":
      return (
        b.kind === "selection" &&
        a.commits.length === b.commits.length &&
        a.commits.every((oid, i) => oid === b.commits[i])
      );
    case "commit":
      return b.kind === "commit" && a.oid === b.oid;
    case "working":
      return b.kind === "working" && a.staged === b.staged;
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
}

export interface SquashEligibility {
  ok: boolean;
  reason?: string;
  /** First parent of the oldest selected commit — the replacement's parent. */
  parent?: string;
  /** Newest selected commit; its tree is the replacement's tree. */
  newest?: string;
  /** True when the range ends at HEAD, so no commits need replaying above it. */
  atTip?: boolean;
}

/** Real commit rows only — excludes the in-window stash nodes that now share
 * `graph.commits` (the Rust layout injects them by time). Batch/squash use array
 * *index* for contiguity, so an interleaved stash node would split an otherwise
 * adjacent commit range; stashes must never take part in that index math. */
function realCommits(graph: RepoGraph | null) {
  return (graph?.commits ?? []).filter((commit) => !commit.stash);
}

/** Every loaded commit any remote-tracking ref contains — i.e. already pushed.
 * Computed in one walk so callers checking a whole range stay linear. */
function remoteReachable(graph: RepoGraph | null): Set<string> {
  const rows = realCommits(graph);
  const parentById = new Map(rows.map((commit) => [commit.id, commit.parents]));
  const stack = rows
    .filter((commit) => commit.refs.some((ref) => ref.kind === RefKind.Remote))
    .map((commit) => commit.id);
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const parent of parentById.get(id) ?? []) stack.push(parent);
  }
  return seen;
}

export function isCommitReachableFromRemote(graph: RepoGraph | null, sha: string): boolean {
  return remoteReachable(graph).has(sha);
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

  return {
    ordered,
    cherryPickOrder: [...ordered].reverse(),
    revertOrder: [...ordered],
    compareRange:
      contiguousRows && firstParentChain && newest && base
        ? { base, head: newest }
        : null,
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

/**
 * Validate that `shas` is a squashable range and return what the write needs:
 * the parent to build the replacement on, the newest commit of the range, and
 * whether it ends at HEAD. Throws with a user-facing message when the selection
 * isn't squashable (the caller toasts it).
 */
export function validateSquashRange(
  graph: RepoGraph | null,
  shas: string[],
): { parent: string; newest: string; atTip: boolean } {
  const { ok, reason, parent, newest, atTip } = getSquashEligibility(graph, shas);
  if (!ok || !parent || !newest) throw new Error(reason ?? "Selection cannot be squashed");
  return { parent, newest, atTip: !!atTip };
}

/** Validate whether `shas` can be squashed: a contiguous run on the first-parent
 * chain below HEAD, with every commit that the rewrite touches — the selection
 * *and* anything above it that has to be replayed — local and single-parent.
 * A remote-reachable commit would mean rewriting published history; a merge in
 * the span can't be replayed linearly. A range ending below HEAD is squashed by
 * `squash_range` (replay), one ending at HEAD by `squash_commits`. */
export function getSquashEligibility(graph: RepoGraph | null, shas: string[]): SquashEligibility {
  if (shas.length < 2) return { ok: false, reason: "Select at least two commits to squash" };
  const rows = realCommits(graph);
  const byId = new Map(rows.map((commit) => [commit.id, commit]));
  if (shas.some((id) => !byId.has(id))) {
    return { ok: false, reason: "Selected commits are not in the loaded graph" };
  }
  // Fail closed when HEAD is unknown: the span to rewrite is defined by walking
  // down from it, and guessing the wrong end would lose commits.
  const head = graph?.head;
  if (!head || !byId.has(head)) {
    return { ok: false, reason: "Can only squash commits on the checked-out branch" };
  }

  // Walk HEAD's first-parent chain down to the oldest pick. That walk *is* the
  // span the rewrite replaces, so contiguity and the local/linear checks below
  // both run over it rather than over time-ordered graph rows.
  const selected = new Set(shas);
  if (selected.size !== shas.length) {
    return { ok: false, reason: "Can only squash distinct commits" };
  }
  const span: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = head;
  let found = 0;
  // `seen` is the loop's only termination guarantee: a corrupt parent chain that
  // cycles back on itself would otherwise spin here and hang the menu render.
  while (cursor && found < selected.size && !seen.has(cursor)) {
    seen.add(cursor);
    span.push(cursor);
    if (selected.has(cursor)) found++;
    cursor = byId.get(cursor)?.parents[0];
  }
  if (found !== selected.size) {
    return { ok: false, reason: "Can only squash commits on the checked-out branch" };
  }
  const first = span.findIndex((id) => selected.has(id));
  const range = span.slice(first, first + selected.size);
  if (!range.every((id) => selected.has(id))) {
    return { ok: false, reason: "Can only squash a contiguous selection" };
  }
  const published = remoteReachable(graph);
  for (const id of span) {
    if (byId.get(id)!.parents.length > 1) return { ok: false, reason: "Can't squash across a merge commit" };
    if (published.has(id)) return { ok: false, reason: "Can only squash commits that have not been pushed" };
  }
  const parent = byId.get(range[range.length - 1])!.parents[0];
  if (!parent) return { ok: false, reason: "Can't squash a root commit" };
  return { ok: true, parent, newest: range[0], atTip: range[0] === head };
}

/**
 * Default commit message for squashing `shas`: the selected commits' own messages
 * concatenated oldest-first (mirroring `git rebase -i` squash), separated by blank
 * lines. Preserving the originals keeps the squash meaningful and — crucially —
 * keeps the first line a real subject, so a repo whose commit-msg hook enforces a
 * format (e.g. Conventional Commits) accepts the result instead of rejecting a
 * generic placeholder. `shas` may be in any order; graph order decides the output.
 */
export function buildSquashMessage(graph: RepoGraph | null, shas: string[]): string {
  const selected = new Set(shas);
  return realCommits(graph)
    .filter((commit) => selected.has(commit.id))
    .reverse() // graph is newest-first; squash lists messages oldest-first
    .map((commit) => fullCommitMessage(commit.summary, commit.body))
    .join("\n\n");
}
