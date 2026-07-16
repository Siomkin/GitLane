import { BranchKind, type BranchInfo } from "./api";

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
