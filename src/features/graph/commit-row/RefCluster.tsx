import { useMemo, useState } from "react";
import type { RefLabel } from "@/lib/api";
import { buildClusterItems } from "@/features/graph/refCluster";
import { CombinedRefPill } from "./CombinedRefPill";
import { RefPill } from "./RefPill";

/** A commit's refs rendered inline as pills before the message. A local branch
 * and the remote-tracking ref(s) of the same name collapse into one pill (saved
 * width for the common in-sync case); clicking it splits them back into the
 * individual RefPills so a specific ref can be dragged / right-clicked. */
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
  if (items.length === 0) return null;
  return (
    <>
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
    </>
  );
}
