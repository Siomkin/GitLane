// Pure helpers for commit selection + squash validation. Extracted from the
// repo store so the non-trivial logic is testable in isolation (no Zustand, no
// IPC). The store calls these and applies the result.

import { RefKind, type RepoGraph } from "@/lib/api";
import { fullCommitMessage } from "@/lib/commitMessage";

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
  parent?: string;
}

/** Real commit rows only — excludes the in-window stash nodes that now share
 * `graph.commits` (the Rust layout injects them by time). Batch/squash use array
 * *index* for contiguity, so an interleaved stash node would split an otherwise
 * adjacent commit range; stashes must never take part in that index math. */
function realCommits(graph: RepoGraph | null) {
  return (graph?.commits ?? []).filter((commit) => !commit.stash);
}

export function isCommitReachableFromRemote(graph: RepoGraph | null, sha: string): boolean {
  const rows = realCommits(graph);
  const parentById = new Map(rows.map((commit) => [commit.id, commit.parents]));
  const stack = rows
    .filter((commit) => commit.refs.some((ref) => ref.kind === RefKind.Remote))
    .map((commit) => commit.id);
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    if (id === sha) return true;
    seen.add(id);
    for (const parent of parentById.get(id) ?? []) stack.push(parent);
  }
  return false;
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

/**
 * Validate that `shas` is a contiguous range ending at HEAD and return the
 * parent oid the squash should soft-reset onto. Throws with a user-facing
 * message when the selection isn't squashable (the caller toasts it).
 *
 * The graph is newest-first, so the newest selected commit must be the branch
 * tip and the chosen rows must be consecutive — otherwise squash would rewrite
 * shared history, which needs interactive rebase (out of scope).
 */
export function validateSquashRange(graph: RepoGraph | null, shas: string[]): string {
  const eligibility = getSquashEligibility(graph, shas);
  if (!eligibility.ok || !eligibility.parent) throw new Error(eligibility.reason ?? "Selection cannot be squashed");
  return eligibility.parent;
}

/** Validate whether `shas` can be squashed by the non-interactive implementation:
 * a contiguous first-parent range ending at HEAD, with no selected commit already
 * reachable from a remote-tracking ref. If a selected commit is remote-reachable,
 * squashing it would rewrite published history and require a force push. */
export function getSquashEligibility(graph: RepoGraph | null, shas: string[]): SquashEligibility {
  if (shas.length < 2) return { ok: false, reason: "Select at least two commits to squash" };
  const rows = realCommits(graph);
  const indexById = new Map(rows.map((c, i) => [c.id, i]));
  const present = shas.filter((id) => indexById.has(id));
  if (present.length !== shas.length) return { ok: false, reason: "Selected commits are not in the loaded graph" };
  const indices = present.map((id) => indexById.get(id)!).sort((a, b) => a - b);
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1) {
      return { ok: false, reason: "Can only squash a contiguous selection" };
    }
  }
  const newestId = rows[indices[0]].id;
  // Fail closed when HEAD is unknown: without it we can't confirm the selection
  // ends at the branch tip, and squashing the wrong end would lose commits.
  if (!graph?.head || newestId !== graph.head) {
    return { ok: false, reason: "Can only squash commits ending at the branch tip (HEAD)" };
  }
  const selected = new Set(present);
  for (const id of selected) {
    if (isCommitReachableFromRemote(graph, id)) {
      return { ok: false, reason: "Can only squash commits that have not been pushed" };
    }
  }
  const oldest = rows[indices[indices.length - 1]];
  const parent = oldest.parents[0];
  if (!parent) return { ok: false, reason: "Can't squash a root commit" };
  return { ok: true, parent };
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
