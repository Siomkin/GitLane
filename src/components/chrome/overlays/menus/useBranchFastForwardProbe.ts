import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { ContextMenu } from "@/store/ui";

interface BranchFastForwardProbeInput {
  /** The exact menu-opening object. Closing and reopening the same branch creates
   * a new owner, so an answer from the previous opening cannot become visible. */
  owner: ContextMenu | null;
  repoPath: string | null;
  targetOid: string | null;
  currentOid: string | null;
  enabled: boolean;
}

interface BranchFastForwardProbeResult {
  owner: ContextMenu;
  repoPath: string;
  targetOid: string;
  currentOid: string;
  canFastForward: boolean;
}

/** Owns the disposable fast-forward read for one exact menu/repo/revision tuple. */
export function useBranchFastForwardProbe({
  owner,
  repoPath,
  targetOid,
  currentOid,
  enabled,
}: BranchFastForwardProbeInput): boolean {
  const [result, setResult] = useState<BranchFastForwardProbeResult | null>(null);
  const eligible = Boolean(enabled && owner && repoPath && targetOid && currentOid);

  useEffect(() => {
    if (!eligible || !owner || !repoPath || !targetOid || !currentOid) return;

    let alive = true;
    const probeOwner = { owner, repoPath, targetOid, currentOid };
    api
      .canFastForward(repoPath, targetOid, currentOid)
      .then((canFastForward) => {
        if (alive) setResult({ ...probeOwner, canFastForward });
      })
      .catch(() => {});

    return () => {
      alive = false;
    };
  }, [currentOid, eligible, owner, repoPath, targetOid]);

  return Boolean(
    eligible &&
      result?.owner === owner &&
      result.repoPath === repoPath &&
      result.targetOid === targetOid &&
      result.currentOid === currentOid &&
      result.canFastForward,
  );
}
