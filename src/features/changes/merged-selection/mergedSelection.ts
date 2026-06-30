// Pure helpers for the merged multi-commit selection inspector (GL-68). No
// React, no IPC — they map the loaded graph + selection into render-ready rows
// and labels, so the container only wires state and the logic stays testable.

import type { RepoGraph } from "../../../lib/api";

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

/** Header count line, e.g. "12 commits selected". */
export function selectionCountLabel(count: number): string {
  return `${count} commit${count === 1 ? "" : "s"} selected`;
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
