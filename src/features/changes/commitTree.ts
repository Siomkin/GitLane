// Pure file-tree builder for the Working Changes Tree view. No React, no IPC —
// it groups a flat list of changed files into a collapsible directory tree and
// flattens it back to render-ready rows.

import type { FileChange } from "@/lib/api";
import { buildPathTree, pathTreeItems, walkPathTree } from "@/lib/pathTree";

/** A flattened row in the commit file tree: a (possibly chain-collapsed)
 * directory header or a leaf file. */
export type Row =
  | {
      kind: "dir";
      key: string;
      label: string;
      depth: number;
      collapsed: boolean;
      count: number;
      paths: string[];
      state: "on" | "off" | "mixed";
    }
  | { kind: "file"; key: string; depth: number; file: FileChange };

/** Build the flattened tree rows for `files`.
 *
 * - `collapsed[fullDirKey]` hides a directory's descendants.
 * - `included(path)` decides each file's checkbox; a directory rolls up to
 *   `on` / `off` / `mixed` from its descendants.
 * - Single-child directory chains (`src/components/chrome`) collapse into one
 *   header row; directories sort before files, both alphabetically.
 */
export function buildRows(
  files: FileChange[],
  collapsed: Record<string, boolean>,
  included: (path: string) => boolean,
): Row[] {
  const rows: Row[] = [];
  walkPathTree(buildPathTree(files, (f) => f.path), {
    dir: ({ key, label, depth, tree }) => {
      const kids = pathTreeItems(tree);
      const onCount = kids.filter((f) => included(f.path)).length;
      const state = onCount === 0 ? "off" : onCount === kids.length ? "on" : "mixed";
      const isCollapsed = !!collapsed[key];
      rows.push({
        kind: "dir",
        key,
        label,
        depth,
        collapsed: isCollapsed,
        count: kids.length,
        paths: kids.map((f) => f.path),
        state,
      });
      return !isCollapsed;
    },
    file: (file, depth) => rows.push({ kind: "file", key: file.path, depth, file }),
  });
  return rows;
}

/** The `files` reordered to match how the Tree view lays them out: grouped by
 * directory (dirs before files, both alphabetical), depth-first. Used to keep
 * the stacked "review all" section order in step with the Tree file list so
 * navigating between the two lands on the same neighbours. Path (flat) order is
 * just the input order, so callers only need this for Tree mode.
 *
 * This is the *fully expanded* tree order — every file, in tree order. It is
 * deliberately independent of the inspector's local collapse state: "review
 * all" always covers every file, so a folder collapsed in the side list only
 * hides rows there, it never drops a section here. */
export function treeOrderedFiles(files: FileChange[]): FileChange[] {
  return buildRows(files, {}, () => true).flatMap((row) =>
    row.kind === "file" ? [row.file] : [],
  );
}
