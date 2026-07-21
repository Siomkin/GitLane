// Pure tree helpers for the right panel's repository Files browser. No React,
// no IPC — one pass groups and sorts the backend's flat path list; a separate
// pass applies local expansion state and flattens that immutable structure to
// render-ready rows.

import { basename } from "@/lib/paths";

/** A flattened row in the Files tree: a (possibly chain-collapsed) directory
 * header or a leaf file. */
export type FileTreeRow =
  | { kind: "dir"; key: string; label: string; depth: number; expanded: boolean }
  | { kind: "file"; key: string; path: string; name: string; depth: number };

interface MutableDir {
  dirs: Map<string, MutableDir>;
  files: string[];
}

/** Expansion-independent repository path tree. Its arrays are sorted once when
 * built and treated as immutable by every flattening pass. */
export interface FileTree {
  readonly dirs: readonly (readonly [name: string, tree: FileTree])[];
  readonly files: readonly string[];
}

/** Group and sort `paths` into an immutable tree. Directory names retain the
 * existing default string-sort semantics; files use basename `localeCompare`.
 * Directories are stored separately so flattening always emits them first. */
export function buildFileTree(paths: readonly string[]): FileTree {
  const root: MutableDir = { dirs: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.push(path);
  }

  const finalize = (node: MutableDir): FileTree => ({
    dirs: [...node.dirs.keys()]
      .sort()
      .map((name) => [name, finalize(node.dirs.get(name)!)] as const),
    files: [...node.files].sort((a, b) => basename(a).localeCompare(basename(b))),
  });

  return finalize(root);
}

/** Flatten a built tree for `expanded`. Directories start collapsed;
 * `expanded[fullDirKey]` opens one. Single-child directory chains
 * (`src/components/chrome`) collapse into one header row. */
export function flattenFileTree(
  tree: FileTree,
  expanded: Readonly<Record<string, boolean>>,
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  const walk = (node: FileTree, depth: number, prefix: string) => {
    for (const [name, child] of node.dirs) {
      let dir = child;
      let label = name;
      let full = prefix ? `${prefix}/${name}` : name;
      while (dir.dirs.length === 1 && dir.files.length === 0) {
        const [childName, childDir] = dir.dirs[0];
        label += `/${childName}`;
        full += `/${childName}`;
        dir = childDir;
      }
      const isExpanded = !!expanded[full];
      rows.push({ kind: "dir", key: full, label, depth, expanded: isExpanded });
      if (isExpanded) walk(dir, depth + 1, full);
    }
    for (const path of node.files) {
      rows.push({ kind: "file", key: path, path, name: basename(path), depth });
    }
  };
  walk(tree, 0, "");
  return rows;
}

/** Case-insensitive substring filter over full repo-relative paths. An empty /
 * whitespace query matches nothing (the caller shows the tree instead). */
export function filterFiles(paths: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return paths.filter((p) => p.toLowerCase().includes(q));
}
