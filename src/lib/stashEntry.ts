import type { CommitNode, StashEntry, StashRef } from "@/lib/api";

/** A stash entry synthesised from its graph node, for a stash that exists only
 * as a node (not in the stash list read). The graph and the inspector share it
 * so a new `StashEntry` field lands in one place. */
export function stashEntryFromNode(node: CommitNode, stash: StashRef): StashEntry {
  return {
    index: stash.index,
    message: stash.message,
    oid: node.id,
    timestamp: node.timestamp,
    baseOid: node.parents[0] ?? null,
    baseTimestamp: null,
    context: [],
  };
}
