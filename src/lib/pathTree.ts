// The one `/`-path tree the file lists share (Working Changes tree, repository
// Files browser): grouping, sort order and single-child chain collapsing live
// here so the two trees always line up. Pure — no React, no IPC.

import { basename } from "./paths";

/** Expansion-independent path tree. Directory names keep the default string
 * sort; items sort by basename `localeCompare`. Arrays are sorted once when
 * built and treated as immutable by every walk. */
export interface PathTree<T> {
  readonly dirs: readonly (readonly [name: string, tree: PathTree<T>])[];
  readonly files: readonly T[];
}

interface MutableDir<T> {
  dirs: Map<string, MutableDir<T>>;
  files: T[];
}

/** Group and sort `items` by their `/`-separated path. */
export function buildPathTree<T>(items: readonly T[], pathOf: (item: T) => string): PathTree<T> {
  const root: MutableDir<T> = { dirs: new Map(), files: [] };
  for (const item of items) {
    const parts = pathOf(item).split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.push(item);
  }

  const finalize = (node: MutableDir<T>): PathTree<T> => ({
    dirs: [...node.dirs.keys()].sort().map((name) => [name, finalize(node.dirs.get(name)!)] as const),
    files: [...node.files].sort((a, b) => basename(pathOf(a)).localeCompare(basename(pathOf(b)))),
  });
  return finalize(root);
}

/** Every item under `tree`: its own files, then each subdirectory's. */
export function pathTreeItems<T>(tree: PathTree<T>): T[] {
  return [...tree.files, ...tree.dirs.flatMap(([, child]) => pathTreeItems(child))];
}

/** Walk `tree` depth-first, directories before files. Single-child directory
 * chains (`src/components/chrome`) collapse into one `dir` visit whose `label`
 * joins them and whose `key` is the full directory path; `dir` returns whether
 * to descend. */
export function walkPathTree<T>(
  tree: PathTree<T>,
  visit: {
    dir: (dir: { key: string; label: string; depth: number; tree: PathTree<T> }) => boolean;
    file: (item: T, depth: number) => void;
  },
): void {
  const walk = (node: PathTree<T>, depth: number, prefix: string) => {
    for (const [name, child] of node.dirs) {
      let dir = child;
      let label = name;
      let key = prefix ? `${prefix}/${name}` : name;
      while (dir.dirs.length === 1 && dir.files.length === 0) {
        const [childName, childDir] = dir.dirs[0];
        label += `/${childName}`;
        key += `/${childName}`;
        dir = childDir;
      }
      if (visit.dir({ key, label, depth, tree: dir })) walk(dir, depth + 1, key);
    }
    for (const item of node.files) visit.file(item, depth);
  };
  walk(tree, 0, "");
}
