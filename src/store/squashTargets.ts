// Branch selection for squash; the existing first-parent validator remains the
// authority for range eligibility. A target is captured when the prompt opens.
import { RefKind, type RepoGraph } from "@/lib/api";
import { getSquashEligibility } from "./selection";

export interface SquashTarget {
  branch: string;
  oid: string;
  repoPath: string;
}

export function otherSquashTargets(
  graph: RepoGraph | null,
  shas: string[],
  currentBranch: string | null,
  repoPath: string,
): SquashTarget[] {
  if (!graph) return [];
  return graph.commits.filter((node) => !node.stash).flatMap((node) => {
    const branches = node.refs.filter((ref) => ref.kind === RefKind.Branch && ref.name !== currentBranch);
    if (!branches.length || !getSquashEligibility({ ...graph, head: node.id }, shas).ok) return [];
    return branches.map((ref) => ({ branch: ref.name, oid: node.id, repoPath }));
  }).sort((a, b) => a.branch.localeCompare(b.branch));
}
