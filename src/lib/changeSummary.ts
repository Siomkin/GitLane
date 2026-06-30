// Aggregates the working tree's per-file git status letters into the
// added / modified / deleted / conflicted buckets the WIP surfaces show.
//
// Each FileChange already carries a one-letter status (M A D R C T U); this
// folds the staged + unstaged + conflicted lists into distinct-file counts so
// the UI can show "+2 ~14 −1" instead of a flat total. Files are counted once
// per path (a path modified in both the index and the worktree is one modified
// file, not two), with a deletion taking precedence over an add and an add over
// a modify when a path carries more than one status.

import type { FileChange, WorkingChanges } from "./api";

export interface ChangeSummary {
  added: number;
  modified: number;
  deleted: number;
  conflicted: number;
}

type Bucket = keyof ChangeSummary;

/** Map a single git status letter to its summary bucket. New (A) and untracked
 * (U) files are "added"; deletions (D) are "deleted"; conflicted (C) is its own
 * bucket; everything else tracked-but-changed — modified, renamed, typechange —
 * is "modified". The backend only emits "C" for conflicts (and routes them
 * through the conflicted list), but the case guards against that ever leaking
 * into staged/unstaged. */
function bucketFor(status: string): Bucket {
  switch (status.toUpperCase()) {
    case "A":
    case "U":
      return "added";
    case "D":
      return "deleted";
    case "C":
      return "conflicted";
    default:
      return "modified";
  }
}

// Higher wins when one path appears with several statuses (e.g. staged-add +
// worktree-delete). Deleted is most significant, then added, then modified.
const RANK: Record<Bucket, number> = { conflicted: 3, deleted: 2, added: 1, modified: 0 };

// Keep the highest-ranked bucket seen for a path (e.g. staged-add +
// worktree-delete nets to deleted).
function rankInto(byPath: Map<string, Bucket>, path: string, bucket: Bucket) {
  const current = byPath.get(path);
  if (current === undefined || RANK[bucket] > RANK[current]) byPath.set(path, bucket);
}

function countBuckets(byPath: Map<string, Bucket>): ChangeSummary {
  const summary: ChangeSummary = { added: 0, modified: 0, deleted: 0, conflicted: 0 };
  for (const bucket of byPath.values()) summary[bucket] += 1;
  return summary;
}

export function summarizeChanges(changes: WorkingChanges): ChangeSummary {
  const byPath = new Map<string, Bucket>();
  for (const file of changes.staged) rankInto(byPath, file.path, bucketFor(file.status));
  for (const file of changes.unstaged) rankInto(byPath, file.path, bucketFor(file.status));
  for (const file of changes.conflicted ?? []) rankInto(byPath, file.path, "conflicted");
  return countBuckets(byPath);
}

/** Bucket a flat changed-file list (e.g. a commit range's net `diffRange`) into
 * the same added/modified/deleted/conflicted counts. A range diff already
 * carries one net entry per path; the per-path ranking is kept so a list with
 * an accidental duplicate path is still counted once. */
export function summarizeFiles(files: FileChange[]): ChangeSummary {
  const byPath = new Map<string, Bucket>();
  for (const file of files) rankInto(byPath, file.path, bucketFor(file.status));
  return countBuckets(byPath);
}

/** Total distinct changed files — the sum of every bucket. */
export function changeTotal(summary: ChangeSummary): number {
  return summary.added + summary.modified + summary.deleted + summary.conflicted;
}
