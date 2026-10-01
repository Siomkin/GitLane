// Pure tree helpers for the right panel's repository Files browser. No React,
// no IPC — the shared `lib/pathTree` groups and sorts the backend's flat path
// list once; a separate pass applies local expansion state and flattens it to
// render-ready rows.

import { basename } from "@/lib/paths";
import { buildPathTree, walkPathTree, type PathTree } from "@/lib/pathTree";

/** A flattened row in the Files tree: a (possibly chain-collapsed) directory
 * header or a leaf file. */
export type FileTreeRow =
  | { kind: "dir"; key: string; label: string; depth: number; expanded: boolean }
  | { kind: "file"; key: string; path: string; name: string; depth: number };

/** Expansion-independent repository path tree, built once per listing. */
export type FileTree = PathTree<string>;

/** Group and sort `paths` into an immutable tree (see `lib/pathTree`). */
export function buildFileTree(paths: readonly string[]): FileTree {
  return buildPathTree(paths, (path) => path);
}

/** Flatten a built tree for `expanded`. Directories start collapsed;
 * `expanded[fullDirKey]` opens one. Single-child directory chains
 * (`src/components/chrome`) collapse into one header row. */
export function flattenFileTree(
  tree: FileTree,
  expanded: Readonly<Record<string, boolean>>,
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  walkPathTree(tree, {
    dir: ({ key, label, depth }) => {
      const isExpanded = !!expanded[key];
      rows.push({ kind: "dir", key, label, depth, expanded: isExpanded });
      return isExpanded;
    },
    file: (path, depth) => rows.push({ kind: "file", key: path, path, name: basename(path), depth }),
  });
  return rows;
}

/** Case-insensitive substring filter over full repo-relative paths. An empty /
 * whitespace query matches nothing (the caller shows the tree instead). */
export function filterFiles(paths: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return paths.filter((p) => p.toLowerCase().includes(q));
}
