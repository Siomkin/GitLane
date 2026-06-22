// Pure file-tree builder for the commit modal's Tree view. No React, no IPC —
// it groups a flat list of staged files into a collapsible directory tree and
// flattens it back to render-ready rows.

import type { FileChange } from "../../lib/api";
import { basename } from "../../lib/paths";

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

interface Dir {
  dirs: Map<string, Dir>;
  files: FileChange[];
}

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
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.push(f);
  }

  const descendants = (dir: Dir): FileChange[] => {
    let out = [...dir.files];
    for (const child of dir.dirs.values()) out = out.concat(descendants(child));
    return out;
  };

  const rows: Row[] = [];
  const walk = (node: Dir, depth: number, prefix: string) => {
    for (const name of [...node.dirs.keys()].sort()) {
      let dir = node.dirs.get(name)!;
      let label = name;
      let full = prefix ? `${prefix}/${name}` : name;
      // Collapse single-child directory chains (src/components/chrome → one row).
      while (dir.dirs.size === 1 && dir.files.length === 0) {
        const childName = [...dir.dirs.keys()][0];
        label += `/${childName}`;
        full += `/${childName}`;
        dir = dir.dirs.get(childName)!;
      }
      const kids = descendants(dir);
      const onCount = kids.filter((f) => included(f.path)).length;
      const state = onCount === 0 ? "off" : onCount === kids.length ? "on" : "mixed";
      const isCollapsed = !!collapsed[full];
      rows.push({
        kind: "dir",
        key: full,
        label,
        depth,
        collapsed: isCollapsed,
        count: kids.length,
        paths: kids.map((f) => f.path),
        state,
      });
      if (!isCollapsed) walk(dir, depth + 1, full);
    }
    for (const f of [...node.files].sort((a, b) => basename(a.path).localeCompare(basename(b.path)))) {
      rows.push({ kind: "file", key: f.path, depth, file: f });
    }
  };
  walk(root, 0, "");
  return rows;
}
