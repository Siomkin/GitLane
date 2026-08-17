// Pure row shaping for the all-files review. Keeping the heterogeneous stream
// out of React makes the virtualization contract easy to test: every file
// header, hunk header, diff line, and notice occupies one virtual row.

import type { FileChange, FileDiff } from "@/lib/api";
import { buildLineMeta, type LineMeta } from "./comments";
import { emptyDiffNotice, flattenUnified, type UnifiedRow } from "./diffRows";

type UnifiedHeaderRow = Extract<UnifiedRow, { kind: "header" }>;
type UnifiedLineRow = Extract<UnifiedRow, { kind: "line" }>;

export type StackedReviewRow =
  | { kind: "file-header"; key: string; file: FileChange; open: boolean }
  | { kind: "loading"; key: string; file: FileChange }
  | { kind: "placeholder"; key: string; file: FileChange; size: number }
  | { kind: "binary"; key: string; file: FileChange; diff: FileDiff }
  | { kind: "hunk"; key: string; file: FileChange; row: UnifiedHeaderRow }
  | { kind: "line"; key: string; file: FileChange; row: UnifiedLineRow }
  | { kind: "truncated"; key: string; file: FileChange }
  | { kind: "message"; key: string; file: FileChange; message: string };

export interface StackedReviewModel {
  rows: StackedReviewRow[];
  headerIndexByPath: Map<string, number>;
  /** Index range (`end` exclusive) of each file's body rows — everything
   * between its header and the next header. Lets the list snapshot the
   * virtualizer's measured body height when a diff is evicted. */
  bodyRangeByPath: Map<string, { start: number; end: number }>;
  linesByFile: Map<string, LineMeta[]>;
}

interface VirtualStackedRow {
  index: number;
  end: number;
}

export function stackedDiffKey(path: string, fullFiles: ReadonlySet<string>): string {
  return fullFiles.has(path) ? `${path}:full` : path;
}

export function buildStackedReviewModel(
  files: FileChange[],
  collapsed: Readonly<Record<string, boolean>>,
  diffs: Readonly<Record<string, FileDiff | null>>,
  fullFiles: ReadonlySet<string>,
  placeholderSizes: Readonly<Record<string, number>> = {},
): StackedReviewModel {
  const rows: StackedReviewRow[] = [];
  const headerIndexByPath = new Map<string, number>();
  const bodyRangeByPath = new Map<string, { start: number; end: number }>();
  const linesByFile = new Map<string, LineMeta[]>();

  for (const file of files) {
    const open = !collapsed[file.path];
    const diffKey = stackedDiffKey(file.path, fullFiles);
    const prefix = `file:${file.path}:${diffKey}`;
    headerIndexByPath.set(file.path, rows.length);
    rows.push({ kind: "file-header", key: `file:${file.path}:header`, file, open });
    const bodyStart = rows.length;

    if (open) {
      const diff = diffs[diffKey];
      if (diff === undefined) {
        const placeholderSize = placeholderSizes[diffKey];
        rows.push(
          placeholderSize === undefined
            ? { kind: "loading", key: `${prefix}:loading`, file }
            : {
                kind: "placeholder",
                key: `${prefix}:placeholder`,
                file,
                size: placeholderSize,
              },
        );
      } else if (diff === null) {
        rows.push({ kind: "message", key: `${prefix}:error`, file, message: "Couldn't load diff." });
      } else if (diff.binary) {
        rows.push({ kind: "binary", key: `${prefix}:binary`, file, diff });
      } else if (diff.hunks.length === 0) {
        rows.push({
          kind: "message",
          key: `${prefix}:empty`,
          file,
          message: emptyDiffNotice(diff.status),
        });
      } else {
        linesByFile.set(file.path, buildLineMeta(diff.hunks));
        for (const row of flattenUnified(diff.hunks)) {
          rows.push(
            row.kind === "header"
              ? { kind: "hunk", key: `${prefix}:${row.key}`, file, row }
              : { kind: "line", key: `${prefix}:${row.key}`, file, row },
          );
        }
        if (diff.truncated) {
          rows.push({ kind: "truncated", key: `${prefix}:truncated`, file });
        }
      }
    }

    bodyRangeByPath.set(file.path, { start: bodyStart, end: rows.length });
  }

  return { rows, headerIndexByPath, bodyRangeByPath, linesByFile };
}

export function estimatedStackedRowSize(row: StackedReviewRow): number {
  switch (row.kind) {
    case "file-header":
      return 44;
    case "hunk":
      return 36;
    case "line":
      return 22;
    case "binary":
      return 120;
    case "placeholder":
      return row.size;
    case "loading":
    case "message":
    case "truncated":
      return 42;
  }
}

/** The file whose body currently crosses the top of the viewport. File-header
 * rows deliberately return null so the full header is not duplicated by the
 * compact sticky breadcrumb while it remains visible. */
export function stackedFileAtViewportTop(
  model: StackedReviewModel,
  virtualRows: readonly VirtualStackedRow[],
  scrollTop: number,
): FileChange | null {
  const top = virtualRows.find((item) => item.end > scrollTop);
  if (!top) return null;
  const row = model.rows[top.index];
  if (!row || row.kind === "file-header") return null;
  return row.file;
}

/** Estimated height retained when an offscreen diff is evicted. Replacing the
 * file body with one equal-size virtual row keeps later file indices stable
 * without retaining the diff's line content or DOM. Fallback only — the
 * eviction path prefers the virtualizer's measured body height, which also
 * accounts for mounted comment cards and binary previews. */
export function estimatedDiffBodySize(diff: FileDiff): number {
  if (diff.binary) return 120;
  let size = diff.truncated ? 42 : 0;
  for (const hunk of diff.hunks) size += 36 + hunk.lines.length * 22;
  return Math.max(size, 42);
}
