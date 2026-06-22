// Pure, IPC-free matching of the commit list for the History view's search +
// kind filter. Kept out of the component (and the store) so the matching rules
// are testable in isolation — the workspace calls `matchingIds` with the
// query/filter it reads from `useUi` and dims the commits that don't match
// (rather than removing them), so the DAG stays whole and matches stand out.

import type { CommitNode } from "../../lib/api";
import type { HistFilter } from "../../store/ui";

/** True when the query or kind filter is active — the cue to switch the list
 * into highlight mode (matches at full strength, everything else dimmed). */
export function isFiltering(query: string, filter: HistFilter): boolean {
  return query.trim() !== "" || filter !== "all";
}

/** A commit is a merge when it has more than one parent (libgit2 reports every
 * parent oid in `parents`); "commits" therefore means the non-merge remainder. */
function matchesFilter(commit: CommitNode, filter: HistFilter): boolean {
  switch (filter) {
    case "commits":
      return commit.parents.length <= 1;
    case "merges":
      return commit.parents.length > 1;
    case "tags":
      return commit.refs.some((ref) => ref.kind === "tag");
    default:
      return true;
  }
}

/** Substring match (case-insensitive) across the fields the placeholder
 * advertises — message/body, SHA, author, and ref names ("branch"). `q` must be
 * already lower-cased and trimmed by the caller. Fields are checked one at a time
 * with an early exit (no per-commit array/string allocation), so typing stays
 * cheap on large loaded graphs. */
function matchesQuery(commit: CommitNode, q: string): boolean {
  if (!q) return true;
  return (
    commit.summary.toLowerCase().includes(q) ||
    commit.body.toLowerCase().includes(q) ||
    commit.id.toLowerCase().includes(q) ||
    commit.shortId.toLowerCase().includes(q) ||
    commit.authorName.toLowerCase().includes(q) ||
    commit.authorEmail.toLowerCase().includes(q) ||
    commit.refs.some((ref) => ref.name.toLowerCase().includes(q))
  );
}

/** True when a commit satisfies the active query *and* kind filter — the
 * highlight criterion. `q` must already be lower-cased and trimmed. */
export function commitMatches(commit: CommitNode, q: string, filter: HistFilter): boolean {
  return matchesFilter(commit, filter) && matchesQuery(commit, q);
}

/** The ids of the commits matching the active query + kind filter, or `null`
 * when nothing is narrowing (the cue to skip dimming and render everything at
 * full strength). The list itself is never trimmed — non-matches are dimmed in
 * place — so this returns only the set membership the painter needs. */
export function matchingIds(
  commits: CommitNode[],
  query: string,
  filter: HistFilter,
): Set<string> | null {
  const q = query.trim().toLowerCase();
  if (!q && filter === "all") return null;
  const ids = new Set<string>();
  for (const commit of commits) {
    if (commitMatches(commit, q, filter)) ids.add(commit.id);
  }
  return ids;
}
