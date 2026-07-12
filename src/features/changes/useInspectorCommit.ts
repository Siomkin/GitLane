import type { CommitNode, StashEntry } from "../../lib/api";
import { useRepo } from "../../store/repo";
import { isCommitReachableFromRemote } from "../../store/selection";

/** The commit (or stash) the right-panel Details view is inspecting, derived
 * from the current selection. Shared by the header's identity/Checkout bar
 * (`CommitCheckoutBar`) and the inspector body (`CommitInspector`) so both agree
 * on what's selected without duplicating the stash-vs-commit resolution. */
export interface InspectorCommit {
  /** The resolved commit node, or null when a stash (or nothing) is selected. */
  selected: CommitNode | null;
  /** The resolved stash entry when a stash node is selected, else undefined. */
  selectedStash: StashEntry | undefined;
  /** Oid of whichever is selected (commit or stash), or undefined when neither. */
  selectedOid: string | undefined;
  /** Short label: the commit's short id, or `stash@{n}` for a stash. */
  selectedShortLabel: string;
  selectedTitle: string;
  selectedBody: string;
  /** True when the selected commit is the unpushed HEAD and can be reworded. */
  canEditMessage: boolean;
}

export function useInspectorCommit(): InspectorCommit {
  const graph = useRepo((state) => state.graph);
  const stashes = useRepo((state) => state.stashes);
  const selectedCommit = useRepo((state) => state.selectedCommit);
  const summary = useRepo((state) => state.summary);

  // Exclude in-window stash nodes (part of `graph.commits`): a selected stash
  // must fall through to the stash path, not render as a commit with no author.
  const selectedGraphCommit = graph?.commits.find(
    (commit) => commit.id === selectedCommit && !commit.stash,
  );
  // Prefer the rich `listStashes` entry, but if that hasn't landed the selected
  // stash may exist only as a graph node — synthesise an entry from it.
  const selectedStashNode = graph?.commits.find(
    (commit) => commit.id === selectedCommit && commit.stash,
  );
  const selectedStash =
    stashes.find((stash) => stash.oid === selectedCommit) ??
    (selectedStashNode?.stash
      ? {
          index: selectedStashNode.stash.index,
          message: selectedStashNode.stash.message,
          oid: selectedStashNode.id,
          timestamp: selectedStashNode.timestamp,
          baseOid: selectedStashNode.parents[0] ?? null,
          baseTimestamp: null,
          context: [],
        }
      : undefined);
  const selected =
    selectedGraphCommit ?? (selectedStash ? null : graph?.commits.find((commit) => !commit.stash) ?? null);
  const selectedOid = selected?.id ?? selectedStash?.oid;
  const selectedShortLabel = selected?.shortId ?? (selectedStash ? `stash@{${selectedStash.index}}` : "");
  const selectedTitle = selected?.summary ?? selectedStash?.message ?? "";
  const selectedBody = selected?.body ?? "";
  const canEditMessage =
    !!summary?.headBranch &&
    !!selected &&
    graph?.head === selected.id &&
    !isCommitReachableFromRemote(graph, selected.id);

  return {
    selected,
    selectedStash,
    selectedOid,
    selectedShortLabel,
    selectedTitle,
    selectedBody,
    canEditMessage,
  };
}
