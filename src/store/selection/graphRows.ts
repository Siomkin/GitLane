// Graph-row helpers shared by the selection, batch, and squash logic. Pure:
// no Zustand, no IPC.

import { RefKind, type RepoGraph } from "@/lib/api";

/** Real commit rows only — excludes the in-window stash nodes that now share
 * `graph.commits` (the Rust layout injects them by time). Batch/squash use array
 * *index* for contiguity, so an interleaved stash node would split an otherwise
 * adjacent commit range; stashes must never take part in that index math. */
export function realCommits(graph: RepoGraph | null) {
  return (graph?.commits ?? []).filter((commit) => !commit.stash);
}

/** Every loaded commit any remote-tracking ref contains — i.e. already pushed.
 * Computed in one walk so callers checking a whole range stay linear. */
export function remoteReachable(graph: RepoGraph | null): Set<string> {
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
