// Pure view-model for the multi-file changes review (GL-174): row derivation,
// the per-file cache key, and the note-surface names — extracted from the
// workspace container so the policies have a test boundary that doesn't
// require mounting the component.

import type { FileChange, WorkingChanges } from "@/lib/api";
import type { ChangeSource } from "@/store/repo";
import { workSurface } from "@/features/review/reviewSurface";

/** One review row: the entry to show for a path, the source its diff comes
 * from, and its cache key within the current snapshot. */
export interface ReviewRow {
  path: string;
  file: FileChange;
  source: ChangeSource;
  key: string;
}

// Working-tree notes are scoped per source (so a staged diff's refs don't share
// with the unstaged diff's); a file's surface is `work:<source>` and the bar
// hands off both. Shared with the single-file review, so a comment shows in both.
// The constructor lives in reviewSurface.ts (the one module that owns the notes
// join key); re-exported here for the changes feature's callers.
export { workSurface };
export const WORK_SURFACES = [workSurface("unstaged"), workSurface("staged")];

/** NUL — the store's key-separator idiom (it appears in no path or status).
 * Built with fromCharCode instead of a unicode escape so tooling can never
 * turn the source literal into a raw NUL byte and mark the file binary. */
export const KEY_SEP = String.fromCharCode(0);

// Cache key for a file's diff WITHIN one working-tree snapshot: path + source
// (plus status/counts so a same-snapshot staged/unstaged flip refetches). NOT a
// content identity — content can change without any of these fields changing,
// so the cache is reset whenever a new snapshot arrives (GL-173).
export function diffKey(source: ChangeSource, file: FileChange) {
  return [source, file.path, file.status, file.add, file.del].join(KEY_SEP);
}

// Stable, de-duplicated file order (alphabetical). A file keeps its slot when
// staged/unstaged, so ticking the checkbox never reorders the list. Each row
// resolves the entry to show and the source its diff comes from.
export function deriveReviewRows(changes: WorkingChanges): ReviewRow[] {
  // Index both sides by path once (O(n)) instead of a linear find per path —
  // this re-runs on every watcher snapshot, so the old join was O(n²). First
  // entry wins, matching the previous `find` semantics for duplicate paths.
  const byPath = (files: FileChange[]) => {
    const map = new Map<string, FileChange>();
    for (const file of files) if (!map.has(file.path)) map.set(file.path, file);
    return map;
  };
  const stagedByPath = byPath(changes.staged);
  const unstagedByPath = byPath(changes.unstaged);
  const paths = Array.from(
    new Set([...changes.unstaged, ...changes.staged].map((file) => file.path)),
  ).sort();
  return paths.map((path) => {
    const stagedEntry = stagedByPath.get(path);
    const unstagedEntry = unstagedByPath.get(path);
    // Show the working-tree entry while anything is still unstaged;
    // otherwise the file is fully staged.
    const file = unstagedEntry ?? stagedEntry!;
    const source: ChangeSource = stagedEntry && !unstagedEntry ? "staged" : "unstaged";
    return { path, file, source, key: diffKey(source, file) };
  });
}

/** The row paths joined into one NUL-separated string — a primitive effect
 * identity for "the set of listed files changed" (default-expansion policy);
 * split on {@link KEY_SEP} to get the paths back. */
export function rowPathsKey(rows: ReviewRow[]): string {
  return rows.map((row) => row.path).join(KEY_SEP);
}
