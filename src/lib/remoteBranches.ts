import { BranchKind, type BranchInfo } from "./api";

export interface RemoteCheckoutCandidate {
  remote: string;
  branch: string;
}

/** Return the local branch to create for a remote-only tracking ref, or null
 * when checkout should fall back to the existing ref. */
export function remoteTrackingCheckoutCandidate(
  branchName: string,
  branches: Pick<BranchInfo, "kind" | "name" | "remote">[],
): RemoteCheckoutCandidate | null {
  const info = branches.find((branch) => branch.kind === BranchKind.Remote && branch.name === branchName);
  const remote = info?.remote ?? null;
  if (!remote || !branchName.startsWith(`${remote}/`)) return null;
  const branch = branchName.slice(remote.length + 1);
  if (!branch) return null;
  const localExists = branches.some((candidate) => candidate.kind === BranchKind.Local && candidate.name === branch);
  return localExists ? null : { remote, branch };
}
