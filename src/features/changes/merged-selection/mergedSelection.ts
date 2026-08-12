// Pure helpers for the merged multi-commit selection inspector (GL-68). No
// React, no IPC — they map the loaded graph + selection into render-ready rows
// and labels, so the container only wires state and the logic stays testable.

import type { RepoGraph } from "@/lib/api";
import type { CompareScope } from "@/store/repoTypes";

/** A selected commit as the inspector's commit list renders it. */
export interface SelectionCommitRow {
  id: string;
  shortId: string;
  summary: string;
  authorName: string;
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

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** Compact "x ago" age from a commit's unix-seconds timestamp, for the commit
 * list sub-line. Mirrors the format of `lib/prs.relativeSince` but takes seconds
 * (commit time) rather than epoch-ms, and never reads the clock implicitly so
 * it stays testable. */
export function relativeCommitDate(timestampSeconds: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, Math.floor(nowMs / 1000) - timestampSeconds);
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < MONTH) return `${Math.floor(diff / DAY)}d ago`;
  if (diff < YEAR) return `${Math.floor(diff / MONTH)}mo ago`;
  return `${Math.floor(diff / YEAR)}y ago`;
}

/** Arguments for reviewing a commits+WIP selection: the compare surface already
 * renders `base` → working tree, so both the inspector's "review all" and the
 * ⌘↵ shortcut hand off to it rather than to the committed-only stacked review. */
export function workingUnionCompare(
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
