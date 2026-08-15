import { useMemo, useState } from "react";
import { headStateOf, type RefLabel } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { buildClusterItems } from "@/features/graph/refCluster";
import { CombinedRefPill } from "./CombinedRefPill";
import { DetachedHeadPill } from "./DetachedHeadPill";
import { RefPill } from "./RefPill";
import { useDetachedWorktreesAt } from "./useDetachedWorktrees";
import { WorktreePill } from "./WorktreePill";

/** A commit's refs rendered inline as pills before the message. A local branch
 * and the remote-tracking ref(s) of the same name collapse into one pill (saved
 * width for the common in-sync case); clicking it splits them back into the
 * individual RefPills so a specific ref can be dragged / right-clicked.
 * Detached worktrees parked on the commit trail the refs as worktree pills —
 * they aren't refs, but they're the only way such a checkout shows up here.
 * A detached HEAD leads with the HEAD pill: no ref carries the ✓ then, so the
 * checked-out row would otherwise be unlabelled. */
export function RefCluster({
  refs,
  currentBranch,
  commitId,
}: {
  refs: RefLabel[];
  currentBranch: string | null;
  /** The commit this row renders — i.e. the oid every ref here points to, used
   * as a tag's checkout/branch target. */
  commitId: string;
}) {
  const [expandedBase, setExpandedBase] = useState<string | null>(null);
  const items = useMemo(() => buildClusterItems(refs, currentBranch), [refs, currentBranch]);
  const detachedWorktrees = useDetachedWorktreesAt(commitId);
  const isDetachedHead = useRepo((s) => {
    const head = headStateOf(s.summary);
    return head.kind === "detached" && head.oid === commitId;
  });
  if (items.length === 0 && detachedWorktrees.length === 0 && !isDetachedHead) return null;
  return (
    <>
      {isDetachedHead && <DetachedHeadPill />}
      {items.map((it) =>
        it.type === "group" ? (
          <CombinedRefPill
            key={`group:${it.base}`}
            base={it.base}
            local={it.local}
            remotes={it.remotes}
            current={it.base === currentBranch}
            expanded={expandedBase === it.base}
            onToggle={() => setExpandedBase((cur) => (cur === it.base ? null : it.base))}
            targetSha={commitId}
          />
        ) : (
          <RefPill
            key={`${it.ref.kind}:${it.ref.name}`}
            refLabel={it.ref}
            current={it.ref.name === currentBranch}
            targetSha={commitId}
          />
        ),
      )}
      {detachedWorktrees.map((wt) => (
        <WorktreePill key={wt.path} wt={wt} />
      ))}
    </>
  );
}
