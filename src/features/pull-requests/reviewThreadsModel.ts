// Pure view-model for the ReviewThreads panel (GL-188): resolved counts, the
// "Hide resolved" filter, and per-file grouping in first-seen thread order —
// extracted so reply/pending rerenders don't redo the work and the semantics
// are testable without a render. No React, no IPC.
import type { ReviewThread } from "../../lib/api";

export interface ThreadFileGroup {
  path: string;
  threads: ReviewThread[];
}

export interface ReviewThreadsModel {
  /** All threads, resolved included — the header badge count. */
  total: number;
  resolvedCount: number;
  /** True when hiding resolved leaves nothing to show (the "all resolved" card). */
  allHidden: boolean;
  /** Visible threads grouped by file, files in first-seen order. */
  byFile: ThreadFileGroup[];
}

export function reviewThreadsModel(threads: ReviewThread[], hideResolved: boolean): ReviewThreadsModel {
  const resolvedCount = threads.filter((t) => t.isResolved).length;
  const visible = hideResolved ? threads.filter((t) => !t.isResolved) : threads;

  // Group visible threads by file, preserving first-seen order.
  const byFile: ThreadFileGroup[] = [];
  for (const t of visible) {
    let group = byFile.find((g) => g.path === t.path);
    if (!group) {
      group = { path: t.path, threads: [] };
      byFile.push(group);
    }
    group.threads.push(t);
  }

  return { total: threads.length, resolvedCount, allHidden: visible.length === 0, byFile };
}
