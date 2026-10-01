// Pure helpers for the merged multi-commit selection inspector (GL-68). No
// React, no IPC — they map the loaded graph + selection into render-ready rows
// and labels, so the container only wires state and the logic stays testable.

import type { RepoGraph } from "@/lib/api";
import type { CompareScope, RepoDataState } from "@/store/repoTypes";
import { workingRange } from "@/store/selection";

/** A selected commit as the inspector's commit list renders it. */
export interface SelectionCommitRow {
  id: string;
  shortId: string;
  summary: string;
  authorName: string;
  authorEmail: string;
  /** Unix seconds (commit author time). */
  timestamp: number;
}

/** Resolve the selected commit ids against the loaded graph into display rows,
 * **newest first** regardless of how the selection was built (a shift-range is
 * already ordered, but additive toggles are in click order). Stash nodes and
 * ids no longer present in the graph are dropped. */
export function mergedCommitRows(graph: RepoGraph | null, ids: string[]): SelectionCommitRow[] {
  const want = new Set(ids);
  const rows: SelectionCommitRow[] = [];
  for (const commit of graph?.commits ?? []) {
    if (commit.stash || !want.has(commit.id)) continue;
    rows.push({
      id: commit.id,
      shortId: commit.shortId,
      summary: commit.summary,
      authorName: commit.authorName,
      authorEmail: commit.authorEmail,
      timestamp: commit.timestamp,
    });
  }
  return rows;
}

/** Header count line, e.g. "12 commits selected". With the WIP row in the pick
 * the uncommitted work is part of the merged diff, so it's named too. */
export function selectionCountLabel(count: number, withUncommitted = false): string {
  const commits = `${count} commit${count === 1 ? "" : "s"}`;
  return withUncommitted ? `${commits} + uncommitted` : `${commits} selected`;
}

type WorkingUnionInput = Pick<RepoDataState, "graph" | "selectionDiff" | "selectedCommits">;

/** How many commits a commits+WIP review covers. A range can't skip rows, so
 * commits between the oldest and newest pick count too; when the range can't
 * be placed on the loaded graph, the pick count stands in. The inspector's
 * label, Enter and ⌘↵ all read this one rule. */
export function workingUnionSpan({ graph, selectionDiff, selectedCommits }: WorkingUnionInput): number {
  return workingRange(graph, selectionDiff?.commits ?? selectedCommits)?.spanned ?? selectedCommits.length;
}

/** Arguments for reviewing a commits+WIP selection that ends at `base`'s
 * working tree: the compare surface already renders `base` → working tree, so
 * the inspector's "review all", Enter and ⌘↵ hand off to it rather than to the
 * committed-only stacked review. */
export function workingUnionReview(state: WorkingUnionInput, base: string) {
  return workingUnionCompare(base, workingUnionSpan(state));
}

function workingUnionCompare(
  base: string,
  spanned: number,
): { base: string; head: null; baseLabel: string; headLabel: string; scope: CompareScope; title: string } {
  const commits = `${spanned} commit${spanned === 1 ? "" : "s"}`;
  return {
    base,
    head: null,
    baseLabel: base.slice(0, 7),
    // The compare view paints the two endpoint labels and drops `title`, so the
    // span has to ride on a label or the review loses the disclosure the
    // inspector makes — that a range covers rows the user didn't select.
    headLabel: `Working tree (${commits})`,
    scope: "working",
    title: `Reviewing ${commits} + uncommitted changes`,
  };
}
