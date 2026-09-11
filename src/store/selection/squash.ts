// Squash validation and the default squash message. Pure: no Zustand, no IPC.

import type { RepoGraph } from "@/lib/api";
import { fullCommitMessage } from "@/lib/commitMessage";
import { realCommits, remoteReachable } from "./graphRows";

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
