import { BranchKind, RefKind, type BranchInfo, type RefLabel } from "@/lib/api";

/** Two-tree range for inspecting a merge against a non-first parent
 * (`parentOid` → merge oid). Index 0 (first parent) returns null so callers
 * keep the existing `commit_files` / `commit_file_diff` path. */
export function inspectParentRange(
  parents: readonly string[] | undefined,
  mergeOid: string | null,
  parentIndex: number,
): { base: string; head: string } | null {
  if (!mergeOid || parentIndex <= 0) return null;
  const parentOid = parents?.[parentIndex];
  if (!parentOid) return null;
  return { base: parentOid, head: mergeOid };
}

export function inspectParentRangeFromGraph(
  graph: { commits: { id: string; parents: string[] }[] } | null | undefined,
  mergeOid: string | null,
  parentIndex: number,
): { base: string; head: string } | null {
  const commit = graph?.commits.find((node) => node.id === mergeOid);
  return inspectParentRange(commit?.parents, mergeOid, parentIndex);
}

/** Short sha plus a ref that points at `oid`, preferring a local branch, then a
 * remote-tracking name, then a tag/branch label on the parent node. */
export function parentInspectLabel(
  oid: string,
  branches: readonly Pick<BranchInfo, "kind" | "name" | "target">[],
  parentRefs: readonly Pick<RefLabel, "kind" | "name">[] = [],
): string {
  const short = oid.slice(0, 7);
  const local = branches.find((branch) => branch.kind === BranchKind.Local && branch.target === oid);
  if (local) return `${short} · ${local.name}`;
  const remote = branches.find((branch) => branch.kind === BranchKind.Remote && branch.target === oid);
  if (remote) return `${short} · ${remote.name}`;
  const tag = parentRefs.find((ref) => ref.kind === RefKind.Tag);
  if (tag) return `${short} · ${tag.name}`;
  const labeled = parentRefs.find(
    (ref) => ref.kind === RefKind.Branch || ref.kind === RefKind.Remote,
  );
  if (labeled) return `${short} · ${labeled.name}`;
  return short;
}
