// Pure tree builder for the right panel's repository Files browser. No React,
// no IPC — it groups the backend's flat sorted path list into a collapsible
// directory tree (collapsed by default) and flattens it to render-ready rows,
// following the commit modal's `commitTree.ts` idiom.

import { basename } from "../../lib/paths";

/** A flattened row in the Files tree: a (possibly chain-collapsed) directory
 * header or a leaf file. */
export type FileTreeRow =
  | { kind: "dir"; key: string; label: string; depth: number; expanded: boolean }
  | { kind: "file"; key: string; path: string; name: string; depth: number };

interface Dir {
  dirs: Map<string, Dir>;
  files: string[];
}

/** Build the flattened tree rows for `paths`. Directories start collapsed;
 * `expanded[fullDirKey]` opens one. Single-child directory chains
 * (`src/components/chrome`) collapse into one header row; directories sort
 * before files, both alphabetically. */
export function buildFileRows(paths: string[], expanded: Record<string, boolean>): FileTreeRow[] {
  const root: Dir = { dirs: new Map(), files: [] };
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

  const rows: FileTreeRow[] = [];
  const walk = (node: Dir, depth: number, prefix: string) => {
    for (const name of [...node.dirs.keys()].sort()) {
      let dir = node.dirs.get(name)!;
      let label = name;
      let full = prefix ? `${prefix}/${name}` : name;
      while (dir.dirs.size === 1 && dir.files.length === 0) {
        const childName = [...dir.dirs.keys()][0];
        label += `/${childName}`;
        full += `/${childName}`;
        dir = dir.dirs.get(childName)!;
      }
      const isExpanded = !!expanded[full];
      rows.push({ kind: "dir", key: full, label, depth, expanded: isExpanded });
      if (isExpanded) walk(dir, depth + 1, full);
    }
    for (const path of [...node.files].sort((a, b) => basename(a).localeCompare(basename(b)))) {
      rows.push({ kind: "file", key: path, path, name: basename(path), depth });
    }
  };
  walk(root, 0, "");
  return rows;
}

/** Case-insensitive substring filter over full repo-relative paths. An empty /
 * whitespace query matches nothing (the caller shows the tree instead). */
export function filterFiles(paths: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return paths.filter((p) => p.toLowerCase().includes(q));
}
