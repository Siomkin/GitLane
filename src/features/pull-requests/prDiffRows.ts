// Pure row model for the PR diff's single virtual window. A PR patch can span
// commits and repeat paths, so row keys include the provider-order file index
// while comment line sequences remain grouped by their persisted file path.

import type { FileDiff } from "@/lib/api/git";
import { buildLineMeta, type LineMeta } from "@/features/review/comments";
import { flattenUnified, type UnifiedRow } from "@/features/review/diffRows";
import { groupByCommit, showCommitHeaders } from "./prDiffGroups";

type UnifiedHeaderRow = Extract<UnifiedRow, { kind: "header" }>;
type UnifiedLineRow = Extract<UnifiedRow, { kind: "line" }>;

export type PrDiffRow =
  | { kind: "commit"; key: string; oid: string; subject?: string }
  | { kind: "file-header"; key: string; file: FileDiff }
  | { kind: "binary"; key: string; file: FileDiff }
  | { kind: "hunk"; key: string; file: FileDiff; row: UnifiedHeaderRow }
  | {
      kind: "line";
      key: string;
      file: FileDiff;
      row: UnifiedLineRow;
      commentKey: string;
    }
  | { kind: "truncated"; key: string; file: FileDiff }
  | { kind: "file-end"; key: string };

export interface PrDiffModel {
  rows: PrDiffRow[];
  linesByFile: Map<string, LineMeta[]>;
  noteFileByKey: Map<string, string>;
}

export function buildPrDiffModel(diffs: FileDiff[]): PrDiffModel {
  const rows: PrDiffRow[] = [];
  const linesByFile = new Map<string, LineMeta[]>();
  const noteFileByKey = new Map<string, string>();
  const groups = groupByCommit(diffs);
  const showHeaders = showCommitHeaders(groups);

  for (const [groupIndex, group] of groups.entries()) {
    if (showHeaders && group.oid) {
      rows.push({
        kind: "commit",
        key: `commit:${groupIndex}:${group.oid}`,
        oid: group.oid,
        subject: group.subject,
      });
    }

    for (const { file, index } of group.files) {
      const prefix = `file:${index}:${file.path}`;
      rows.push({ kind: "file-header", key: `${prefix}:header`, file });

      if (file.binary) {
        rows.push({ kind: "binary", key: `${prefix}:binary`, file });
      } else {
        linesByFile.set(prefix, buildLineMeta(file.hunks));
        noteFileByKey.set(prefix, file.path);
        for (const row of flattenUnified(file.hunks)) {
          rows.push(
            row.kind === "header"
              ? { kind: "hunk", key: `${prefix}:${row.key}`, file, row }
              : {
                  kind: "line",
                  key: `${prefix}:${row.key}`,
                  file,
                  row,
                  commentKey: prefix,
                },
          );
        }
        if (file.truncated) {
          rows.push({ kind: "truncated", key: `${prefix}:truncated`, file });
        }
      }

      rows.push({ kind: "file-end", key: `${prefix}:end` });
    }
  }

  return { rows, linesByFile, noteFileByKey };
}

export function estimatedPrDiffRowSize(row: PrDiffRow): number {
  switch (row.kind) {
    case "commit":
      return 38;
    case "file-header":
      return 42;
    case "hunk":
      return 36;
    case "line":
      return 22;
    case "binary":
      return 120;
    case "truncated":
      return 42;
    case "file-end":
      return 17;
  }
}
