// Pure view-model for the Include diff: where a file sits in the changed-file
// list, stepping between differences (wrapping into the neighbouring file), the
// header counts, and why a control is unavailable.

import type { Difference, FileDiff } from "@/lib/api";
import { hunkPatchUnavailableReason } from "@/features/review/hunkActions";

/** `index` of `path` in `order` (-1 when absent) and the list length. */
export function filePosition(order: string[], path: string): { index: number; total: number } {
  return { index: order.indexOf(path), total: order.length };
}

/** The path `step` places from `path`, or null past either end. */
export function neighbourFile(order: string[], path: string, step: 1 | -1): string | null {
  const index = order.indexOf(path);
  if (index < 0) return order[0] ?? null;
  return order[index + step] ?? null;
}

export function differenceCounts(differences: Difference[]): { total: number; included: number } {
  return {
    total: differences.length,
    included: differences.filter((d) => d.inclusion === "included").length,
  };
}

export const countsLabel = ({ total, included }: { total: number; included: number }) =>
  `${total} ${total === 1 ? "difference" : "differences"}, ${included} included`;

/** Where stepping from `current` lands: another difference in this file, or the
 * neighbouring file (`edge` says which end of it to land on). */
export type DifferenceStep = { kind: "here"; index: number } | { kind: "file"; edge: "first" | "last" };

export function stepDifference(count: number, current: number | null, step: 1 | -1): DifferenceStep {
  if (count === 0) return { kind: "file", edge: step === 1 ? "first" : "last" };
  if (current == null) return { kind: "here", index: step === 1 ? 0 : count - 1 };
  const next = current + step;
  if (next < 0) return { kind: "file", edge: "last" };
  if (next >= count) return { kind: "file", edge: "first" };
  return { kind: "here", index: next };
}

/** Why revert is unavailable on a difference, or null when it is offered. */
export function revertUnavailableReason(difference: Difference): string | null {
  if (difference.inclusion === "included") return "Exclude this difference before reverting it";
  if (difference.inclusion === "partial") return "Part of this difference is staged; exclude it before reverting";
  return null;
}

/** Why the file shows no per-difference controls, or null when it does. */
export function wholeFileReason(diff: FileDiff, differences: Difference[]): string | null {
  if (differences.length > 0) return null;
  if (diff.hunks.length === 0) return null;
  return (
    hunkPatchUnavailableReason(diff)?.replace("staged as a file", "included as a whole") ??
    "This file can only be included as a whole"
  );
}

/** The difference that starts on one of a row's lines in `hunkIndex`, if any. */
export function differenceStartingAt(
  differences: Difference[],
  hunkIndex: number,
  lineIndexes: number[],
): number {
  return differences.findIndex((d) => d.hunkIndex === hunkIndex && lineIndexes.includes(d.lineStart));
}
