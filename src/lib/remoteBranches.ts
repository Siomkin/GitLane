import { BranchKind, type BranchInfo } from "./api";

/** The branch a remote-tracking ref names, using its own recorded remote rather
 * than splitting on the first slash (a remote may contain one). A local branch
 * has no prefix to strip, so this is identity for those. */
export function shortName(branch: Pick<BranchInfo, "name" | "remote">): string {
  const prefix = branch.remote ? `${branch.remote}/` : "";
  return prefix && branch.name.startsWith(prefix) ? branch.name.slice(prefix.length) : branch.name;
}

export interface RemoteCheckoutCandidate {
  remote: string;
  branch: string;
}

/** Resolve a remote-tracking ref to the same-name local checkout. The backend
 * creates the local branch when missing, or safely fast-forwards an existing
 * local branch before checking it out. */
export function remoteTrackingCheckoutCandidate(
  branchName: string,
  branches: Pick<BranchInfo, "kind" | "name" | "remote">[],
): RemoteCheckoutCandidate | null {
  const info = branches.find((branch) => branch.kind === BranchKind.Remote && branch.name === branchName);
  const remote = info?.remote ?? null;
  if (!remote || !branchName.startsWith(`${remote}/`)) return null;
  const branch = branchName.slice(remote.length + 1);
  if (!branch) return null;
  return { remote, branch };
}
